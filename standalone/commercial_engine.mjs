import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { scrubSecrets } from './config.mjs';
import {
  decryptCredentials,
  encryptCredentials,
  maskApiKey,
  resolveVaultMasterKey,
} from './crypto_vault.mjs';
import {
  computeExchangeOrderSizing,
  inspectApiKeyPermissions,
} from './instrument_specs.mjs';
import {
  COMMERCIAL_PLANS,
  resolveLicenseSigningSecret,
  verifyLicenseKey,
} from './license_issuer.mjs';
import { OkxClient, buildPostOnlyEntryOrder, buildReduceOnlySlTpOrders } from './exchange_okx.mjs';
import {
  BinanceFuturesClient,
  buildBinancePostOnlyEntryOrder,
  buildBinanceReduceOnlySlTpOrders,
} from './exchange_binance.mjs';
import {
  computeV8MacroRegimeRadar,
  evaluateStrategy,
  loadOfflineOrDbDataset,
  loadRuntimeSpecs,
} from './engine_runtime.mjs';
import { CommercialStore } from './commercial_store.mjs';

const ALPHANUM_CLORDID_RE = /^[A-Za-z0-9]{1,32}$/;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function hashPinScrypt(pin, existingSaltHex = null) {
  const saltHex = existingSaltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32).toString('hex');
  return `${saltHex}:${derived}`;
}

function verifyPinScrypt(pin, storedHash) {
  if (!pin || typeof pin !== 'string' || !storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [saltHex, expectedHex] = parts;
  const actualHex = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), 32).toString('hex');
  const a = Buffer.from(actualHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function utcDayString(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function classifyCapitalBracket(equityUsdt) {
  const eq = Number(equityUsdt);
  if (!Number.isFinite(eq) || eq < 150) {
    return {
      bracket: 'MICRO',
      recommendedSymbols: ['SOLUSDT.P', 'BNBUSDT.P', 'BTCUSDT.P'],
      maxConcurrentPositions: 1,
      defaultRiskPct: 1.0,
    };
  }
  if (eq <= 2000) {
    return {
      bracket: 'STANDARD',
      recommendedSymbols: ['BTCUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P'],
      maxConcurrentPositions: 3,
      defaultRiskPct: 1.0,
    };
  }
  return {
    bracket: 'PRO_WHALE',
    recommendedSymbols: ['BTCUSDT.P', 'ETHUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P'],
    maxConcurrentPositions: 4,
    defaultRiskPct: 1.25,
  };
}

/**
 * Generates a strictly alphanumeric `^[A-Za-z0-9]{1,32}$` multi-tenant client order ID
 * so different subscribers never collide on OKX / Binance.
 */
export function makeTenantClientOrderId({
  subscriberId = 'sub0',
  exchange = 'OKX',
  symbol = 'BTCUSDT.P',
  timeframe = '1h',
  barTime = 0,
  side = 1,
  leg = 'E',
} = {}) {
  const subTag = sha256Hex(subscriberId).slice(0, 6);
  const coin = String(symbol || 'BTC')
    .toUpperCase()
    .replace(/USDT\.P$|USDT$|-USDT-SWAP$/, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 3) || 'BTC';
  const tf = String(timeframe || '1h').replace(/[^A-Za-z0-9]/g, '').slice(0, 3) || '1h';
  const sideCode = (side === 1 || String(side).toLowerCase() === 'buy' || String(side).toLowerCase() === 'long') ? 'L' : 'S';
  const legCode = String(leg || 'E').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'E';

  const canonical = `${subscriberId}|${String(exchange).toUpperCase()}|${String(symbol).toUpperCase()}|${tf}|${Number(barTime) || 0}|${sideCode}|${legCode}`;
  const digest = sha256Hex(canonical).slice(0, 12);
  const id = `t10${subTag}${coin}${tf}${sideCode}${legCode}${digest}`.slice(0, 32);
  assert.ok(ALPHANUM_CLORDID_RE.test(id), `Invalid alphanumeric tenant clOrdId "${id}"`);
  return id;
}

function redactSubscriberRow(subRow, credRow = null, riskRow = null) {
  if (!subRow) return null;
  const plan = COMMERCIAL_PLANS[subRow.plan_id] || null;
  return {
    subscriberId: subRow.subscriber_id,
    name: subRow.name,
    email: subRow.email,
    planId: subRow.plan_id,
    planName: plan?.name ?? subRow.plan_id,
    licenseExpiresAt: subRow.license_expires_at,
    licenseExpiresIso: new Date(subRow.license_expires_at).toISOString(),
    exchange: subRow.exchange,
    simulated: Boolean(subRow.simulated),
    executionMode: subRow.execution_mode,
    preferredVersion: subRow.preferred_version,
    riskTier: subRow.risk_tier,
    riskPct: subRow.risk_pct,
    maxLeverageCap: subRow.max_leverage_cap,
    maxDailyLossPct: subRow.max_daily_loss_pct,
    maxDdKillPct: subRow.max_dd_kill_pct,
    hasArmingPin: Boolean(subRow.arming_pin_hash),
    hasCredentials: Boolean(credRow),
    keyMask: credRow?.key_mask ?? null,
    hasWithdrawPerm: credRow ? Boolean(credRow.has_withdraw_perm) : false,
    permissionSummary: credRow?.permission_summary ?? null,
    riskState: riskRow || null,
    status: subRow.status,
    createdAt: subRow.created_at,
    updatedAt: subRow.updated_at,
  };
}

export class CommercialPlatformEngine {
  constructor({ store, commercialStore = null, config, runtimeSpecs = null, exchangeClientFactory = null } = {}) {
    assert.ok(store, 'StandaloneStore is required for CommercialPlatformEngine');
    assert.ok(config, 'Config is required for CommercialPlatformEngine');
    this.store = store;
    this.cStore = commercialStore || new CommercialStore(store);
    this.config = config;
    this.runtimeSpecs = runtimeSpecs;
    this.exchangeClientFactory = exchangeClientFactory;
    this.cStore.recoverInterruptedSubscriberOrders();
  }

  async ensureRuntimeSpecs() {
    if (!this.runtimeSpecs) {
      this.runtimeSpecs = await loadRuntimeSpecs(this.config.repoRoot);
    }
    return this.runtimeSpecs;
  }

  _buildTenantExchangeClient({ subscriberId, exchange, simulated, creds, executionMode, maxLeverageCap, maxOrderUsdt }) {
    if (typeof this.exchangeClientFactory === 'function') {
      return this.exchangeClientFactory({ subscriberId, exchange, simulated, creds, executionMode, maxLeverageCap, maxOrderUsdt });
    }
    const ex = String(exchange || 'OKX').toUpperCase();
    const dryRun = executionMode === 'SCAN_AND_SIGNAL_ONLY';
    const exMode = executionMode === 'SCAN_AND_SIGNAL_ONLY' ? 'PAPER' : 'LIVE_ARMED';
    const confirmTok = this.config.liveConfirmToken || `tenant_${subscriberId}`;
    if (ex === 'BINANCE') {
      return new BinanceFuturesClient({
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        testnet: Boolean(simulated),
        dryRun,
        executionMode: exMode,
        liveConfirmToken: confirmTok,
        maxLeverageCap,
        maxOrderUsdt,
      });
    }
    return new OkxClient({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      passphrase: creds.passphrase || '',
      simulated: Boolean(simulated),
      dryRun,
      executionMode: exMode,
      liveConfirmToken: confirmTok,
      maxLeverageCap,
      maxOrderUsdt,
    });
  }

  _decryptTenantCreds(subscriberId, credRow, { forLiveAutoTrade }) {
    const { key } = resolveVaultMasterKey(this.config, { forLiveAutoTrade });
    const aad = `${subscriberId}|${credRow.exchange}`;
    return decryptCredentials(credRow.envelope, key, aad);
  }

  async simulateCapitalPreview({
    equityUsdt = 1000,
    availableMarginUsdt = null,
    exchange = 'OKX',
    version = 'v9',
    riskTier = 'SAFE_75WR',
    riskPct = null,
    maxLeverageCap = 3.0,
    maxOrderUsdt = 50000,
    symbols = ['BTCUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P', 'ETHUSDT.P'],
    timeframe = '1h',
    overlayOverrides = null,
  } = {}) {
    const eq = Number(equityUsdt);
    assert.ok(Number.isFinite(eq) && eq > 0, 'equityUsdt must be a positive number');
    const runtimeSpecs = await this.ensureRuntimeSpecs();
    const bracket = classifyCapitalBracket(eq);
    const effRiskPct = Number.isFinite(Number(riskPct)) && Number(riskPct) > 0
      ? Number(riskPct)
      : bracket.defaultRiskPct;
    const availMargin = availableMarginUsdt !== null && availableMarginUsdt !== undefined && Number.isFinite(Number(availableMarginUsdt))
      ? Number(availableMarginUsdt)
      : eq;

    const previewRows = [];
    for (const symbol of symbols) {
      let evalRes = null;
      let regimeRes = null;
      let lastClose = 0;
      let latestBarTime = Math.floor(Date.now() / 1000);
      let loadedDataset = null;

      if (overlayOverrides?.[symbol]) {
        evalRes = overlayOverrides[symbol];
        regimeRes = evalRes.regime || { regime: 'BULL_TREND', trendScore: 0.5, longPriority: 1, shortPriority: 0 };
        lastClose = evalRes.lastClose ?? evalRes.activeOverlay?.limitPrice ?? evalRes.activeOverlay?.entry ?? 100;
        latestBarTime = evalRes.latestBarTime ?? latestBarTime;
      } else {
        try {
          const loaded = loadOfflineOrDbDataset({
            store: this.store,
            config: this.config,
            symbol,
            timeframe,
            minBars: 220,
            prefer5y: true,
          });
          loadedDataset = loaded.dataset;
          latestBarTime = loadedDataset.rows[loadedDataset.rows.length - 1].time;
          lastClose = loadedDataset.rows[loadedDataset.rows.length - 1].close;
          regimeRes = computeV8MacroRegimeRadar({
            repoRoot: this.config.repoRoot,
            runtimeSpecs,
            dataset: loadedDataset,
            fundingRates: loaded.fundingRates,
            macroData: loaded.macroData,
            symbol,
            timeframe,
          });
          evalRes = evaluateStrategy({
            dataset: loadedDataset,
            fundingRates: loaded.fundingRates,
            macroData: loaded.macroData,
            timeframe,
            symbol,
            exchange,
            execProfile: 'EXCHANGE_POST_ONLY',
            mlEnabled: true,
            version,
            riskTier,
            config: { ...this.config, maxLeverageCap },
            runtimeSpecs,
          });
        } catch (err) {
          previewRows.push({
            symbol,
            timeframe,
            barTime: latestBarTime,
            status: 'DATA_UNAVAILABLE',
            regime: 'UNKNOWN',
            feasible: false,
            skipReason: scrubSecrets(err.message, this.config),
          });
          continue;
        }
      }

      const ov = evalRes.activeOverlay || { status: 'FLAT' };
      const isActive = ov.status === 'PENDING_LIMIT' || ov.status === 'OPEN_POSITION';
      const status = isActive ? 'ACTIVE_SIGNAL' : 'REGIME_READY_PREVIEW';
      const regName = regimeRes?.regime || evalRes.regime?.regime || 'RANGE_CHOP';
      const side = isActive
        ? ov.side
        : ((regimeRes?.shortPriority ?? 0) > (regimeRes?.longPriority ?? 0) ? -1 : 1);

      const entryPx = isActive
        ? Number(ov.limitPrice ?? ov.entry ?? lastClose)
        : Number(lastClose);
      const minStopPct = Number(evalRes.execOptions?.minStopPct ?? 1.4) / 100;
      const stopAtrMult = Number(evalRes.execOptions?.stopAtr ?? 3.2);
      const lastAtr = Number(evalRes.signalsAudit?.[evalRes.signalsAudit.length - 1]?.atr ?? entryPx * minStopPct);
      const fallbackStopDist = Math.max(lastAtr * stopAtrMult, entryPx * minStopPct);
      const slPx = isActive && Number.isFinite(Number(ov.stop))
        ? Number(ov.stop)
        : entryPx - side * fallbackStopDist;
      const rr = Number(evalRes.execOptions?.rewardRisk ?? 1.25);
      const tpPx = isActive && Number.isFinite(Number(ov.target))
        ? Number(ov.target)
        : entryPx + side * Math.abs(entryPx - slPx) * rr;
      const stratLev = Number(ov.lev ?? evalRes.execOptions?.minLev ?? 1.5);
      const probWin = ov.probWin ?? ov.lastSignal?.probWin ?? null;

      const sizing = computeExchangeOrderSizing({
        exchange,
        symbol,
        side,
        entryPrice: entryPx,
        stopPrice: slPx,
        targetPrice: tpPx,
        equityUsdt: eq,
        availableMarginUsdt: availMargin,
        riskPct: effRiskPct,
        strategyLev: stratLev,
        maxLeverageCap,
        maxOrderUsdt,
        sizeMult: 1.0,
      });

      previewRows.push({
        symbol,
        timeframe,
        barTime: ov.signalTime ?? ov.entryTime ?? latestBarTime,
        overlayStatus: ov.status,
        status,
        side,
        regime: regName,
        probWin,
        entryPx: sizing.tickEntryPx,
        slPx: sizing.tickSlPx,
        tpPx: sizing.tickTpPx,
        strategyLev: Math.min(stratLev, maxLeverageCap),
        modelVersion: evalRes.summary?.modelVersion || version,
        szOrQtyString: sizing.szOrQtyString,
        contractsSz: sizing.contractsSz,
        baseCoinQty: sizing.baseCoinQty,
        notionalUsdt: Number(sizing.notionalUsdt.toFixed(4)),
        marginRequiredUsdt: Number(sizing.marginRequiredUsdt.toFixed(4)),
        estimatedRiskUsdt: Number(sizing.estimatedRiskUsdt.toFixed(4)),
        estimatedProfitUsdt: Number(sizing.estimatedProfitUsdt.toFixed(4)),
        estimatedFeeUsdt: Number(sizing.estimatedFeeUsdt.toFixed(4)),
        estimatedLiqPx: Number(sizing.estimatedLiqPx.toFixed(4)),
        feasible: sizing.feasible,
        skipReason: sizing.skipReason,
      });
    }

    return {
      ready: true,
      exchange: String(exchange).toUpperCase(),
      version,
      riskTier,
      equityUsdt: eq,
      availableMarginUsdt: availMargin,
      riskPct: effRiskPct,
      bracket,
      rows: previewRows,
    };
  }

  async onboardSubscriber({
    name,
    email = null,
    licenseKey,
    exchange = 'OKX',
    simulated = true,
    apiKey = '',
    apiSecret = '',
    passphrase = '',
    rawPermissionPayload = null,
    armingPin = '',
    executionMode = 'SCAN_AND_SIGNAL_ONLY',
    preferredVersion = 'v9',
    riskTier = 'SAFE_75WR',
    riskPct = 1.0,
    maxLeverageCap = 3.0,
    maxDailyLossPct = 5.0,
    maxDdKillPct = 20.0,
    webhookUrl = null,
    clientOverride = null,
    simulatedEquityUsdt = null,
    overlayOverrides = null,
  } = {}) {
    assert.ok(typeof name === 'string' && name.trim().length > 0, 'Subscriber name is required');
    const signingSecret = resolveLicenseSigningSecret(this.config);
    const lic = verifyLicenseKey(licenseKey, signingSecret);
    if (!lic.valid) {
      throw new Error(`License rejected: ${lic.reason}`);
    }

    const mode = String(executionMode || 'SCAN_AND_SIGNAL_ONLY').toUpperCase();
    if (!lic.plan.allowedModes.includes(mode)) {
      throw new Error(`Plan ${lic.plan.id} does not permit executionMode=${mode}`);
    }

    const ex = String(exchange || 'OKX').trim().toUpperCase();
    const hasKeys = Boolean(apiKey && apiSecret);

    // Hard-block withdrawal permission regardless of mode whenever permission payload is inspected
    let permSummary = hasKeys ? 'UNVERIFIED_KEY' : 'ZERO_KEY_SCAN_ONLY';
    let hasWithdrawPerm = false;
    if (rawPermissionPayload) {
      const permCheck = inspectApiKeyPermissions({ exchange: ex, rawPermissionPayload });
      hasWithdrawPerm = permCheck.hasWithdrawPermission;
      permSummary = permCheck.reason;
      if (hasWithdrawPerm) {
        throw new Error('SECURITY BLOCK: Exchange API key has WITHDRAW permission enabled. Withdrawals must be disabled.');
      }
      if (!permCheck.safeForAutoTrade && mode !== 'SCAN_AND_SIGNAL_ONLY') {
        throw new Error(`Exchange API key permission unsafe for auto-trade: ${permCheck.reason}`);
      }
    }

    if (mode !== 'SCAN_AND_SIGNAL_ONLY') {
      assert.ok(typeof armingPin === 'string' && armingPin.trim().length >= 4,
        `armingPin (>= 4 chars) is required for ${mode}`);
    }

    const subscriberId = `sub_${crypto.randomBytes(8).toString('hex')}`;
    const sessionToken = `sub_tok_${crypto.randomBytes(24).toString('hex')}`;
    const sessionTokenHash = sha256Hex(sessionToken);
    const armingPinHash = armingPin && armingPin.trim().length >= 4 ? hashPinScrypt(armingPin.trim()) : null;

    let keyMask = null;
    if (hasKeys) {
      const forLive = mode === 'LIVE_AUTO_TRADE';
      const { key } = resolveVaultMasterKey(this.config, { forLiveAutoTrade: forLive });
      const envelope = encryptCredentials(
        { apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), passphrase: String(passphrase || '').trim() },
        key,
        `${subscriberId}|${ex}`,
      );
      keyMask = envelope.keyMask || maskApiKey(apiKey);
      this.cStore.upsertEncryptedCredentials({
        subscriberId,
        exchange: ex,
        keyMask,
        hasWithdrawPerm: false,
        permissionSummary: permSummary,
        envelope,
      });
    }

    const subRow = this.cStore.upsertSubscriber({
      subscriberId,
      name: name.trim(),
      email,
      sessionTokenHash,
      armingPinHash,
      licenseKey,
      planId: lic.plan.id,
      licenseExpiresAt: lic.payload.expiresAtMs,
      exchange: ex,
      simulated: Boolean(simulated),
      executionMode: mode,
      preferredVersion,
      riskTier,
      riskPct,
      maxLeverageCap,
      maxDailyLossPct,
      maxDdKillPct,
      webhookUrl,
      status: 'ACTIVE',
    });

    const scanRes = await this.scanSubscriberAccount(subscriberId, {
      simulatedEquityUsdt: simulatedEquityUsdt ?? (hasKeys ? null : 1000),
      clientOverride,
      overlayOverrides,
    });

    const credRow = this.cStore.getEncryptedCredentials(subscriberId);
    const riskRow = this.cStore.getRiskState(subscriberId);
    return {
      subscriber: redactSubscriberRow(subRow, credRow, riskRow),
      sessionToken,
      keyMask,
      scan: scanRes.scan,
      tickets: scanRes.tickets,
    };
  }

  authenticateSubscriber({ subscriberId = null, sessionToken } = {}) {
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new Error('Unauthorized: missing subscriber sessionToken');
    }
    const tokenHash = sha256Hex(sessionToken);
    const row = subscriberId
      ? this.cStore.getSubscriberById(subscriberId)
      : this.cStore.getSubscriberByTokenHash(tokenHash);
    if (!row || row.status !== 'ACTIVE') {
      throw new Error('Unauthorized: subscriber not found or inactive');
    }
    const a = Buffer.from(tokenHash, 'hex');
    const b = Buffer.from(row.session_token_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error('Unauthorized: invalid subscriber sessionToken');
    }
    const credRow = this.cStore.getEncryptedCredentials(row.subscriber_id);
    const riskRow = this.cStore.getRiskState(row.subscriber_id);
    return redactSubscriberRow(row, credRow, riskRow);
  }

  async scanSubscriberAccount(subscriberId, {
    simulatedEquityUsdt = null,
    availableMarginUsdt = null,
    clientOverride = null,
    timeframe = '1h',
    overlayOverrides = null,
  } = {}) {
    const sub = this.cStore.getSubscriberById(subscriberId);
    assert.ok(sub, `Unknown subscriber: ${subscriberId}`);
    const plan = COMMERCIAL_PLANS[sub.plan_id];
    const credRow = this.cStore.getEncryptedCredentials(subscriberId);

    let totalEq = Number(simulatedEquityUsdt);
    let availEq = availableMarginUsdt !== null && availableMarginUsdt !== undefined ? Number(availableMarginUsdt) : NaN;
    let openPositions = [];
    let scannedMode = 'SIMULATED_PAPER_PREVIEW';

    if (simulatedEquityUsdt === null || simulatedEquityUsdt === undefined) {
      if (clientOverride) {
        const health = await clientOverride.getAccountHealth();
        totalEq = Number(health.totalEqUsdt ?? health.totalWalletBalance ?? 1000);
        availEq = Number(health.availEqUsdt ?? health.availableBalance ?? totalEq);
        openPositions = health.openPositions || [];
        scannedMode = health.simulated ? 'EXCHANGE_DEMO' : 'EXCHANGE_LIVE_READ';
      } else if (credRow?.envelope) {
        const creds = this._decryptTenantCreds(subscriberId, credRow, {
          forLiveAutoTrade: sub.execution_mode === 'LIVE_AUTO_TRADE',
        });
        const client = this._buildTenantExchangeClient({
          subscriberId,
          exchange: sub.exchange,
          simulated: Boolean(sub.simulated),
          creds,
          executionMode: sub.execution_mode,
          maxLeverageCap: sub.max_leverage_cap,
          maxOrderUsdt: plan?.maxCapitalUsdt ?? 5000,
        });
        const health = await client.getAccountHealth();
        totalEq = Number(health.totalEqUsdt ?? health.totalWalletBalance ?? 1000);
        availEq = Number(health.availEqUsdt ?? health.availableBalance ?? totalEq);
        openPositions = health.openPositions || [];
        scannedMode = sub.simulated ? 'EXCHANGE_DEMO' : 'EXCHANGE_LIVE_READ';
      } else {
        totalEq = 1000;
        availEq = 1000;
        scannedMode = 'ZERO_KEY_PREVIEW';
      }
    }

    if (!Number.isFinite(totalEq) || totalEq <= 0) totalEq = 100;
    if (!Number.isFinite(availEq) || availEq < 0) availEq = totalEq;

    // Update Daily Loss Circuit Breaker & High-Water MaxDD Kill Switch
    const today = utcDayString();
    const prevRisk = this.cStore.getRiskState(subscriberId);
    const dayStartEq = (!prevRisk || prevRisk.day_utc !== today)
      ? totalEq
      : Number(prevRisk.day_start_equity_usdt);
    const highWaterEq = prevRisk
      ? Math.max(Number(prevRisk.high_water_equity_usdt), totalEq)
      : totalEq;
    const dailyLossPct = dayStartEq > 0 ? Math.max(0, ((dayStartEq - totalEq) / dayStartEq) * 100) : 0;
    const drawdownPct = highWaterEq > 0 ? Math.max(0, ((highWaterEq - totalEq) / highWaterEq) * 100) : 0;

    const sameDayPrevCb = prevRisk && prevRisk.day_utc === today && prevRisk.circuitBreakerTripped;
    const cbTripped = Boolean(sameDayPrevCb || dailyLossPct >= Number(sub.max_daily_loss_pct));
    const killTripped = Boolean((prevRisk && prevRisk.killSwitchTripped) || drawdownPct >= Number(sub.max_dd_kill_pct));

    let tripReason = prevRisk?.trip_reason || null;
    if (killTripped && !prevRisk?.killSwitchTripped) {
      tripReason = `KILL_SWITCH_MAX_DD_${drawdownPct.toFixed(2)}PCT_GE_${sub.max_dd_kill_pct}PCT`;
    } else if (cbTripped && !sameDayPrevCb) {
      tripReason = `CIRCUIT_BREAKER_DAILY_LOSS_${dailyLossPct.toFixed(2)}PCT_GE_${sub.max_daily_loss_pct}PCT`;
    }

    const riskState = this.cStore.upsertRiskState({
      subscriberId,
      dayUtc: today,
      dayStartEquityUsdt: dayStartEq,
      highWaterEquityUsdt: highWaterEq,
      lastEquityUsdt: totalEq,
      dailyLossPct: Number(dailyLossPct.toFixed(4)),
      drawdownPct: Number(drawdownPct.toFixed(4)),
      circuitBreakerTripped: cbTripped,
      killSwitchTripped: killTripped,
      tripReason,
    });

    const bracket = classifyCapitalBracket(totalEq);
    const scan = this.cStore.insertAccountScan({
      subscriberId,
      exchange: sub.exchange,
      scannedMode,
      totalEquityUsdt: totalEq,
      availMarginUsdt: availEq,
      openPositions,
      capitalBracket: bracket.bracket,
    });

    const allowedCryptoSyms = (plan?.allowedSymbols || ['BTCUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P'])
      .filter(s => s.endsWith('USDT.P'));
    const preview = await this.simulateCapitalPreview({
      equityUsdt: totalEq,
      availableMarginUsdt: availEq,
      exchange: sub.exchange,
      version: sub.preferred_version,
      riskTier: sub.risk_tier,
      riskPct: sub.risk_pct,
      maxLeverageCap: sub.max_leverage_cap,
      maxOrderUsdt: plan?.maxCapitalUsdt ?? 5000,
      symbols: allowedCryptoSyms,
      timeframe,
      overlayOverrides,
    });

    const tickets = preview.rows.map(r => ({
      ticketId: `${subscriberId}:${r.symbol}:${r.timeframe}:${r.barTime}`,
      symbol: r.symbol,
      timeframe: r.timeframe,
      barTime: r.barTime,
      side: r.side ?? 1,
      status: r.status,
      regime: r.regime,
      probWin: r.probWin,
      entryPx: r.entryPx ?? null,
      slPx: r.slPx ?? null,
      tpPx: r.tpPx ?? null,
      szOrQty: r.szOrQtyString ?? '0',
      notionalUsdt: r.notionalUsdt ?? 0,
      estRiskUsdt: r.estimatedRiskUsdt ?? 0,
      estProfitUsdt: r.estimatedProfitUsdt ?? 0,
      estLiqPx: r.estimatedLiqPx ?? 0,
      feasible: Boolean(r.feasible),
      skipReason: r.skipReason ?? null,
      modelVersion: r.modelVersion ?? sub.preferred_version,
      strategyLev: r.strategyLev ?? 1.5,
    }));
    this.cStore.upsertSignalTickets(subscriberId, tickets);
    const latestTickets = tickets.map(tk => ({
      ...tk,
      ticket_id: tk.ticketId,
      bar_time: tk.barTime,
      entry_px: tk.entryPx,
      sl_px: tk.slPx,
      tp_px: tk.tpPx,
      sz_or_qty: tk.szOrQty,
      notional_usdt: tk.notionalUsdt,
    }));

    return {
      scan,
      bracket,
      riskState,
      latestTickets,
      tickets: this.cStore.listSignalTickets(subscriberId, 20),
    };
  }

  updateSubscriberMode(subscriberId, {
    executionMode,
    armingPin = '',
    maxDailyLossPct,
    maxDdKillPct,
    preferredVersion,
    riskTier,
    riskPct,
    maxLeverageCap,
    resetTrips = false,
  } = {}) {
    const sub = this.cStore.getSubscriberById(subscriberId);
    assert.ok(sub, `Unknown subscriber: ${subscriberId}`);
    const plan = COMMERCIAL_PLANS[sub.plan_id];
    const credRow = this.cStore.getEncryptedCredentials(subscriberId);

    const nextMode = String(executionMode || sub.execution_mode).toUpperCase();
    if (!plan || !plan.allowedModes.includes(nextMode)) {
      throw new Error(`Plan ${sub.plan_id} does not allow mode ${nextMode}`);
    }
    if (Date.now() >= Number(sub.license_expires_at)) {
      throw new Error('Subscription license has expired');
    }

    if (nextMode === 'DEMO_AUTO_TRADE' || nextMode === 'LIVE_AUTO_TRADE') {
      if (!sub.arming_pin_hash || !verifyPinScrypt(armingPin, sub.arming_pin_hash)) {
        throw new Error('Invalid armingPin for auto-trade mode activation');
      }
      if (!credRow) {
        throw new Error(`Encrypted exchange API credentials required before enabling ${nextMode}`);
      }
      if (credRow.hasWithdrawPerm) {
        throw new Error('SECURITY BLOCK: API key has withdrawal permission');
      }
      if (nextMode === 'LIVE_AUTO_TRADE') {
        resolveVaultMasterKey(this.config, { forLiveAutoTrade: true });
      }
    }

    if (resetTrips) {
      const curRisk = this.cStore.getRiskState(subscriberId);
      if (curRisk) {
        this.cStore.upsertRiskState({
          subscriberId,
          dayUtc: curRisk.day_utc,
          dayStartEquityUsdt: curRisk.last_equity_usdt,
          highWaterEquityUsdt: curRisk.last_equity_usdt,
          lastEquityUsdt: curRisk.last_equity_usdt,
          dailyLossPct: 0,
          drawdownPct: 0,
          circuitBreakerTripped: false,
          killSwitchTripped: false,
          tripReason: null,
        });
      }
    }

    const updated = this.cStore.updateSubscriberSettings(subscriberId, {
      executionMode: nextMode,
      simulated: nextMode === 'LIVE_AUTO_TRADE' ? false : (nextMode === 'DEMO_AUTO_TRADE' ? true : Boolean(sub.simulated)),
      maxDailyLossPct,
      maxDdKillPct,
      preferredVersion,
      riskTier,
      riskPct,
      maxLeverageCap,
    });
    return redactSubscriberRow(updated, credRow, this.cStore.getRiskState(subscriberId));
  }

  /**
   * Executes one Multi-Tenant Auto-Trade cycle strictly enforcing all 7 Commercial Guardrails:
   * (1) Valid non-expired license & allowed mode, (2) No-withdraw key, (3) Valid armingPin,
   * (4) Daily-loss circuit breaker not tripped, (5) High-water MaxDD kill switch not tripped,
   * (6) Equity <= plan.maxCapitalUsdt & lev <= maxLeverageCap, (7) Feasible exchange lotSz + idempotent clOrdId.
   */
  async runSubscriberAutoTradeCycle(subscriberId, {
    armingPin = '',
    simulatedEquityUsdt = null,
    availableMarginUsdt = null,
    clientOverride = null,
    timeframe = '1h',
    overlayOverrides = null,
  } = {}) {
    const sub = this.cStore.getSubscriberById(subscriberId);
    assert.ok(sub, `Unknown subscriber: ${subscriberId}`);

    // Guardrail 1: Valid non-expired license & allowed mode
    const lic = verifyLicenseKey(sub.license_key, resolveLicenseSigningSecret(this.config));
    if (!lic.valid) {
      return { executed: false, blockedReason: `GUARDRAIL_1_LICENSE_${lic.reason}`, actions: [] };
    }
    const mode = sub.execution_mode;
    if (!lic.plan.allowedModes.includes(mode)) {
      return { executed: false, blockedReason: `GUARDRAIL_1_MODE_NOT_ALLOWED_${mode}`, actions: [] };
    }
    if (mode === 'SCAN_AND_SIGNAL_ONLY') {
      const scanRes = await this.scanSubscriberAccount(subscriberId, {
        simulatedEquityUsdt, availableMarginUsdt, clientOverride, timeframe, overlayOverrides,
      });
      return { executed: false, action: 'SCAN_ONLY_NO_ORDERS', scan: scanRes.scan, tickets: scanRes.tickets, actions: [] };
    }

    // Guardrail 2: Credentials exist & withdraw perm disabled
    const credRow = this.cStore.getEncryptedCredentials(subscriberId);
    if (!credRow || !credRow.envelope) {
      return { executed: false, blockedReason: 'GUARDRAIL_2_MISSING_CREDENTIALS', actions: [] };
    }
    if (credRow.hasWithdrawPerm) {
      return { executed: false, blockedReason: 'GUARDRAIL_2_WITHDRAW_PERMISSION_BLOCKED', actions: [] };
    }

    // Guardrail 3: Valid armingPin
    if (!sub.arming_pin_hash || !verifyPinScrypt(armingPin, sub.arming_pin_hash)) {
      return { executed: false, blockedReason: 'GUARDRAIL_3_INVALID_ARMING_PIN', actions: [] };
    }

    // Resolve vault key cleanly before scanning/routing (enforces >=32 char master key in LIVE_AUTO_TRADE)
    const forLive = mode === 'LIVE_AUTO_TRADE';
    const creds = this._decryptTenantCreds(subscriberId, credRow, { forLiveAutoTrade: forLive });

    const client = clientOverride || this._buildTenantExchangeClient({
      subscriberId,
      exchange: sub.exchange,
      simulated: !forLive,
      creds,
      executionMode: mode,
      maxLeverageCap: sub.max_leverage_cap,
      maxOrderUsdt: lic.plan.maxCapitalUsdt,
    });

    // Run fresh account scan + risk state update
    const scanRes = await this.scanSubscriberAccount(subscriberId, {
      simulatedEquityUsdt, availableMarginUsdt, clientOverride: client, timeframe, overlayOverrides,
    });
    const { scan, bracket, riskState, latestTickets } = scanRes;

    // Guardrail 4 & 5: Daily loss circuit breaker & High-water MaxDD kill switch
    if (riskState.circuitBreakerTripped) {
      return { executed: false, blockedReason: 'GUARDRAIL_4_CIRCUIT_BREAKER_TRIPPED', riskState, actions: [] };
    }
    if (riskState.killSwitchTripped) {
      return { executed: false, blockedReason: 'GUARDRAIL_5_KILL_SWITCH_TRIPPED', riskState, actions: [] };
    }

    // Guardrail 6: Plan max capital cap
    if (scan.total_equity_usdt > lic.plan.maxCapitalUsdt) {
      return {
        executed: false,
        blockedReason: `GUARDRAIL_6_EQUITY_EXCEEDS_PLAN_MAX_${lic.plan.maxCapitalUsdt}`,
        riskState,
        actions: [],
      };
    }

    // Guardrail 7: Cancel expired pending maker entries, then execute feasible active tickets with idempotent clOrdId
    const maxSlots = Math.min(lic.plan.maxConcurrentPositions, bracket.maxConcurrentPositions);
    const activeFeasible = (latestTickets || []).filter(t => t.status === 'ACTIVE_SIGNAL' && t.feasible).slice(0, maxSlots);
    const activeEntryClIds = new Set(
      activeFeasible.map(tk =>
        makeTenantClientOrderId({
          subscriberId,
          exchange: sub.exchange,
          symbol: tk.symbol,
          timeframe: tk.timeframe,
          barTime: tk.bar_time,
          side: tk.side,
          leg: 'E',
        }),
      ),
    );
    const openPosSymbols = new Set((scan.openPositions || []).map(p => p.instId || p.symbol).filter(Boolean));

    const actions = [];
    const confirmTok = this.config.liveConfirmToken || `tenant_${subscriberId}`;

    // Cancel stale SUBMITTED post-only entries if signal expired/flipped and no live position holds that symbol
    const priorSubmittedEntries = this.cStore
      .getSubscriberOrdersLog({ subscriberId, limit: 30 })
      .filter(o => !o.reduceOnly && ['post_only', 'LIMIT_GTX'].includes(o.order_type) && o.status === 'SUBMITTED');
    for (const oldOrd of priorSubmittedEntries) {
      if (activeEntryClIds.has(oldOrd.client_order_id)) continue;
      if (openPosSymbols.has(oldOrd.symbol)) continue;
      if (typeof client.cancelOrder !== 'function') continue;

      const cancelId = `t10${sha256Hex(oldOrd.client_order_id + '|C').slice(0, 29)}`;
      if (this.cStore.findSubscriberOrder(cancelId)) continue;
      this.cStore.upsertSubscriberOrderLog({
        clientOrderId: cancelId,
        subscriberId,
        exchange: sub.exchange,
        symbol: oldOrd.symbol,
        mode,
        orderType: 'CANCEL',
        side: oldOrd.side === 'buy' ? 'sell' : 'buy',
        price: oldOrd.price,
        qty: oldOrd.qty,
        reduceOnly: false,
        status: 'SUBMITTING',
        payload: { origClOrdId: oldOrd.client_order_id },
      });
      try {
        const cRes = sub.exchange === 'OKX'
          ? await client.cancelOrder({ symbol: oldOrd.symbol, clOrdId: oldOrd.client_order_id }, { confirmToken: confirmTok })
          : await client.cancelOrder({ symbol: oldOrd.symbol, origClientOrderId: oldOrd.client_order_id }, { confirmToken: confirmTok });
        this.cStore.upsertSubscriberOrderLog({
          clientOrderId: cancelId,
          subscriberId,
          exchange: sub.exchange,
          symbol: oldOrd.symbol,
          mode,
          orderType: 'CANCEL',
          side: oldOrd.side === 'buy' ? 'sell' : 'buy',
          price: oldOrd.price,
          qty: oldOrd.qty,
          reduceOnly: false,
          status: 'CANCELLED',
          response: cRes,
        });
        this.cStore.upsertSubscriberOrderLog({
          clientOrderId: oldOrd.client_order_id,
          subscriberId,
          exchange: sub.exchange,
          symbol: oldOrd.symbol,
          mode,
          orderType: oldOrd.order_type,
          side: oldOrd.side,
          price: oldOrd.price,
          qty: oldOrd.qty,
          reduceOnly: false,
          status: 'CANCELLED',
        });
        actions.push({ action: 'CANCELLED_STALE', clientOrderId: oldOrd.client_order_id, symbol: oldOrd.symbol });
      } catch (err) {
        const safeErr = scrubSecrets(err.message, this.config);
        this.cStore.upsertSubscriberOrderLog({
          clientOrderId: cancelId,
          subscriberId,
          exchange: sub.exchange,
          symbol: oldOrd.symbol,
          mode,
          orderType: 'CANCEL',
          side: oldOrd.side === 'buy' ? 'sell' : 'buy',
          price: oldOrd.price,
          qty: oldOrd.qty,
          reduceOnly: false,
          status: 'REJECTED',
          response: { error: safeErr },
        });
      }
    }

    for (const tk of activeFeasible) {
      const clOrdId = makeTenantClientOrderId({
        subscriberId,
        exchange: sub.exchange,
        symbol: tk.symbol,
        timeframe: tk.timeframe,
        barTime: tk.bar_time,
        side: tk.side,
        leg: 'E',
      });
      const existing = this.cStore.findSubscriberOrder(clOrdId);
      if (existing && ['SUBMITTED', 'SUBMITTING'].includes(existing.status)) {
        actions.push({ action: 'IDEMPOTENT_SKIP', clientOrderId: clOrdId, symbol: tk.symbol, status: existing.status });
        continue;
      }

      const sideStr = tk.side === 1 ? 'buy' : 'sell';
      const entryPayload = sub.exchange === 'OKX'
        ? buildPostOnlyEntryOrder({ symbol: tk.symbol, side: tk.side, sz: tk.sz_or_qty, px: String(tk.entry_px), clOrdId })
        : buildBinancePostOnlyEntryOrder({ symbol: tk.symbol, side: tk.side, quantity: tk.sz_or_qty, price: String(tk.entry_px), newClientOrderId: clOrdId });

      this.cStore.upsertSubscriberOrderLog({
        clientOrderId: clOrdId,
        subscriberId,
        exchange: sub.exchange,
        symbol: tk.symbol,
        mode,
        orderType: sub.exchange === 'OKX' ? 'post_only' : 'LIMIT_GTX',
        side: sideStr,
        price: tk.entry_px,
        qty: tk.sz_or_qty,
        reduceOnly: false,
        status: 'SUBMITTING',
        payload: entryPayload,
      });

      try {
        const entryRes = sub.exchange === 'OKX'
          ? await client.placePostOnlyEntry(
              { symbol: tk.symbol, side: tk.side, sz: tk.sz_or_qty, px: String(tk.entry_px), clOrdId },
              { confirmToken: confirmTok, notionalUsdt: tk.notional_usdt },
            )
          : await client.placePostOnlyEntry(
              { symbol: tk.symbol, side: tk.side, quantity: tk.sz_or_qty, price: String(tk.entry_px), newClientOrderId: clOrdId },
              { confirmToken: confirmTok, notionalUsdt: tk.notional_usdt },
            );

        const exOrdId = Array.isArray(entryRes?.data) ? (entryRes.data[0]?.ordId ?? null) : (entryRes?.data?.orderId ? String(entryRes.data.orderId) : null);
        this.cStore.upsertSubscriberOrderLog({
          clientOrderId: clOrdId,
          subscriberId,
          exchange: sub.exchange,
          symbol: tk.symbol,
          mode,
          orderType: sub.exchange === 'OKX' ? 'post_only' : 'LIMIT_GTX',
          side: sideStr,
          price: tk.entry_px,
          qty: tk.sz_or_qty,
          reduceOnly: false,
          status: 'SUBMITTED',
          exchangeOrderId: exOrdId,
          payload: entryPayload,
          response: entryRes,
        });
        actions.push({ action: 'SUBMITTED', clientOrderId: clOrdId, symbol: tk.symbol, exchangeOrderId: exOrdId, qty: tk.sz_or_qty });

        // Place reduceOnly SL/TP protection leg
        const slClOrdId = makeTenantClientOrderId({
          subscriberId,
          exchange: sub.exchange,
          symbol: tk.symbol,
          timeframe: tk.timeframe,
          barTime: tk.bar_time,
          side: tk.side,
          leg: 'O',
        });
        const slPayload = sub.exchange === 'OKX'
          ? buildReduceOnlySlTpOrders({ symbol: tk.symbol, entrySide: tk.side, sz: tk.sz_or_qty, slTriggerPx: tk.sl_px, tpTriggerPx: tk.tp_px, algoClOrdId: slClOrdId })
          : buildBinanceReduceOnlySlTpOrders({ symbol: tk.symbol, entrySide: tk.side, quantity: tk.sz_or_qty, stopPrice: tk.sl_px, takeProfitPrice: tk.tp_px, slClientOrderId: slClOrdId });

        this.cStore.upsertSubscriberOrderLog({
          clientOrderId: slClOrdId,
          subscriberId,
          exchange: sub.exchange,
          symbol: tk.symbol,
          mode,
          orderType: sub.exchange === 'OKX' ? 'oco_reduce_only' : 'SL_TP_REDUCE_ONLY',
          side: tk.side === 1 ? 'sell' : 'buy',
          price: tk.sl_px,
          qty: tk.sz_or_qty,
          reduceOnly: true,
          status: 'SUBMITTING',
          payload: slPayload,
        });

        const slRes = sub.exchange === 'OKX'
          ? await client.placeReduceOnlySlTp({ symbol: tk.symbol, entrySide: tk.side, sz: tk.sz_or_qty, slTriggerPx: tk.sl_px, tpTriggerPx: tk.tp_px, algoClOrdId: slClOrdId }, { confirmToken: confirmTok })
          : await client.placeReduceOnlySlTp({ symbol: tk.symbol, entrySide: tk.side, quantity: tk.sz_or_qty, stopPrice: tk.sl_px, takeProfitPrice: tk.tp_px, slClientOrderId: slClOrdId }, { confirmToken: confirmTok });

        const algoId = Array.isArray(slRes?.data) ? (slRes.data[0]?.algoId ?? null) : null;
        this.cStore.upsertSubscriberOrderLog({
          clientOrderId: slClOrdId,
          subscriberId,
          exchange: sub.exchange,
          symbol: tk.symbol,
          mode,
          orderType: sub.exchange === 'OKX' ? 'oco_reduce_only' : 'SL_TP_REDUCE_ONLY',
          side: tk.side === 1 ? 'sell' : 'buy',
          price: tk.sl_px,
          qty: tk.sz_or_qty,
          reduceOnly: true,
          status: 'SUBMITTED',
          exchangeOrderId: algoId,
          payload: slPayload,
          response: slRes,
        });
        actions.push({ action: 'SL_TP_SUBMITTED', clientOrderId: slClOrdId, symbol: tk.symbol, exchangeOrderId: algoId });
      } catch (err) {
        const safeErr = scrubSecrets(err.message, this.config);
        this.cStore.upsertSubscriberOrderLog({
          clientOrderId: clOrdId,
          subscriberId,
          exchange: sub.exchange,
          symbol: tk.symbol,
          mode,
          orderType: sub.exchange === 'OKX' ? 'post_only' : 'LIMIT_GTX',
          side: sideStr,
          price: tk.entry_px,
          qty: tk.sz_or_qty,
          reduceOnly: false,
          status: 'REJECTED',
          payload: entryPayload,
          response: { error: safeErr },
        });
        actions.push({ action: 'REJECTED', clientOrderId: clOrdId, symbol: tk.symbol, error: safeErr });
      }
    }

    return {
      executed: true,
      mode,
      scan,
      bracket,
      riskState,
      actions,
      orders: this.cStore.getSubscriberOrdersLog({ subscriberId, limit: 20 }),
    };
  }

  getSubscriberDashboard(subscriberId) {
    const sub = this.cStore.getSubscriberById(subscriberId);
    assert.ok(sub, `Unknown subscriber: ${subscriberId}`);
    const credRow = this.cStore.getEncryptedCredentials(subscriberId);
    const riskState = this.cStore.getRiskState(subscriberId);
    const latestScan = this.cStore.getLatestAccountScan(subscriberId);
    const tickets = this.cStore.listSignalTickets(subscriberId, 30);
    const orders = this.cStore.getSubscriberOrdersLog({ subscriberId, limit: 50 });

    return {
      subscriber: redactSubscriberRow(sub, credRow, riskState),
      latestScan,
      bracket: latestScan ? classifyCapitalBracket(latestScan.total_equity_usdt) : null,
      riskState,
      tickets,
      orders,
    };
  }

  getAdminOverview() {
    const subs = this.cStore.listSubscribers(500);
    const summaries = subs.map(s => {
      const cred = this.cStore.getEncryptedCredentials(s.subscriber_id);
      const risk = this.cStore.getRiskState(s.subscriber_id);
      const scan = this.cStore.getLatestAccountScan(s.subscriber_id);
      return {
        ...redactSubscriberRow(s, cred, risk),
        latestEquityUsdt: scan?.total_equity_usdt ?? null,
        capitalBracket: scan?.capital_bracket ?? null,
      };
    });
    const recentOrders = this.cStore.getSubscriberOrdersLog({ limit: 50 });
    return {
      totalSubscribers: summaries.length,
      activeSubscribers: summaries.filter(s => s.status === 'ACTIVE').length,
      byPlan: Object.fromEntries(
        Object.keys(COMMERCIAL_PLANS).map(pid => [pid, summaries.filter(s => s.planId === pid).length]),
      ),
      subscribers: summaries,
      recentOrders,
    };
  }
}
