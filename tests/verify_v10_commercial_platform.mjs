import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig, redactConfig, scrubSecrets } from '../standalone/config.mjs';
import { StandaloneStore } from '../standalone/store_sqlite.mjs';
import { loadRuntimeSpecs } from '../standalone/engine_runtime.mjs';
import { createStandaloneServer } from '../standalone/server.mjs';
import { OkxClient } from '../standalone/exchange_okx.mjs';
import {
  decryptCredentials,
  encryptCredentials,
  maskApiKey,
  resolveVaultMasterKey,
} from '../standalone/crypto_vault.mjs';
import {
  BINANCE_USDM_DEFAULT_SPECS,
  OKX_SWAP_DEFAULT_SPECS,
  computeExchangeOrderSizing,
  inspectApiKeyPermissions,
} from '../standalone/instrument_specs.mjs';
import {
  COMMERCIAL_PLANS,
  issueLicenseKey,
  resolveLicenseSigningSecret,
  verifyLicenseKey,
} from '../standalone/license_issuer.mjs';
import { CommercialStore } from '../standalone/commercial_store.mjs';
import {
  CommercialPlatformEngine,
  classifyCapitalBracket,
  makeTenantClientOrderId,
} from '../standalone/commercial_engine.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ALPHANUM_CLORDID_RE = /^[A-Za-z0-9]{1,32}$/;

function makeTmpDir(prefix = 'tt-v10-verify-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeActiveOverlay({ side = 1, price = 90000, barTime = 1765000000 } = {}) {
  return {
    summary: { modelVersion: 'v9.0-WalkForwardEnsemble' },
    regime: {
      regime: side === 1 ? 'BULL_TREND' : 'BEAR_TREND',
      trendScore: 0.72 * side,
      longPriority: side === 1 ? 1 : 0,
      shortPriority: side === -1 ? 1 : 0,
    },
    execOptions: { stopAtr: 3.2, minStopPct: 1.4, rewardRisk: 1.25, minLev: 1.5 },
    lastClose: price,
    latestBarTime: barTime,
    activeOverlay: {
      status: 'PENDING_LIMIT',
      side,
      signalTime: barTime,
      limitPrice: price,
      stop: price - side * (price * 0.02),
      target: price + side * (price * 0.025),
      lev: 1.5,
      probWin: 0.77,
    },
  };
}

function flipFirstHexNibble(hexStr) {
  const first = hexStr[0].toLowerCase();
  const replacement = first === 'a' ? 'b' : 'a';
  return replacement + hexStr.slice(1);
}

describe('1. AES-256-GCM Vault Security, Raw SQLite Byte Audit & Secret Scrubbing', () => {
  it('enforces AES-256-GCM authTag/ciphertext/AAD tamper rejection and >=32-char LIVE master key', () => {
    const masterKey = 'v10-commercial-master-key-32chars-minimum!!';
    const aad = 'sub_tenant_01|OKX';
    const creds = {
      apiKey: 'okx_live_key_alpha_9f2a',
      apiSecret: 'okx_ultra_secret_never_plaintext_8841',
      passphrase: 'okx_passphrase_never_plaintext_5512',
    };

    const envelope = encryptCredentials(creds, masterKey, aad);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.alg, 'aes-256-gcm');
    assert.equal(envelope.keyMask, maskApiKey(creds.apiKey));
    assert.equal(envelope.keyMask, 'okx_****9f2a');

    const roundTrip = decryptCredentials(envelope, masterKey, aad);
    assert.deepEqual(roundTrip, creds);

    // Tampered ciphertext, authTag, salt, IV, wrong key, and mismatched AAD must all fail
    assert.throws(
      () => decryptCredentials({ ...envelope, ciphertextHex: flipFirstHexNibble(envelope.ciphertextHex) }, masterKey, aad),
    );
    assert.throws(
      () => decryptCredentials({ ...envelope, tagHex: flipFirstHexNibble(envelope.tagHex) }, masterKey, aad),
    );
    assert.throws(
      () => decryptCredentials({ ...envelope, saltHex: flipFirstHexNibble(envelope.saltHex) }, masterKey, aad),
    );
    assert.throws(
      () => decryptCredentials({ ...envelope, ivHex: flipFirstHexNibble(envelope.ivHex) }, masterKey, aad),
    );
    assert.throws(
      () => decryptCredentials(envelope, 'wrong-master-key-32-chars-minimum!!', aad),
    );
    assert.throws(
      () => decryptCredentials(envelope, masterKey, 'sub_tenant_02|OKX'),
    );

    // Short master key fails in LIVE_AUTO_TRADE
    assert.throws(
      () => resolveVaultMasterKey({ commercialMasterKey: 'short-key-16chars' }, { forLiveAutoTrade: true }),
      /COMMERCIAL_MASTER_KEY \(>= 32 chars\) required for LIVE_AUTO_TRADE/,
    );
    const liveKey = resolveVaultMasterKey({ commercialMasterKey: masterKey }, { forLiveAutoTrade: true });
    assert.equal(liveKey.ephemeral, false);
    assert.equal(liveKey.key, masterKey);
  });

  it('proves zero plaintext secrets exist in raw .sqlite/.wal/.shm bytes and across HTTP responses', async () => {
    const tmp = makeTmpDir('tt-v10-sqlite-');
    const dbPath = path.join(tmp, 'vault_audit.sqlite');
    const masterSecret = 'vault-master-32chars-strictly-secret-999';
    const licenseSecret = 'vault-license-hmac-secret-strict-888';
    const adminToken = 'vault-admin-bearer-token-strict-777';
    const apiKey = 'okx_buyer_pub_11229f2a';
    const apiSecret = 'PLAINTEXT_API_SECRET_SHOULD_NOT_APPEAR_ON_DISK';
    const passphrase = 'PLAINTEXT_PASSPHRASE_SHOULD_NOT_APPEAR_ON_DISK';
    const armingPin = '948271';

    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        RISK_TIER: 'SAFE_75WR',
        COMMERCIAL_MASTER_KEY: masterSecret,
        COMMERCIAL_LICENSE_SECRET: licenseSecret,
        COMMERCIAL_ADMIN_TOKEN: adminToken,
      },
    });
    const store = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({
      config: cfg,
      store,
      runtimeSpecs,
      exchangeClientFactory: () => ({
        async getAccountHealth() {
          return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 2400, availEqUsdt: 2100, openPositions: [] };
        },
      }),
    });

    let sessionToken = '';
    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      const licRes = await fetch(`${base}/api/commercial/admin/licenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ planId: 'PRO_AUTO_TRADER', subscriberRef: 'audit@buyer.io', durationDays: 30 }),
      });
      assert.equal(licRes.status, 200);
      const licJson = await licRes.json();

      const onboardRes = await fetch(`${base}/api/commercial/subscribers/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Audit Buyer',
          email: 'audit@buyer.io',
          licenseKey: licJson.licenseKey,
          exchange: 'OKX',
          simulated: true,
          apiKey,
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin,
          executionMode: 'DEMO_AUTO_TRADE',
        }),
      });
      assert.equal(onboardRes.status, 200);
      const onboardJson = await onboardRes.json();
      sessionToken = onboardJson.sessionToken;

      const statusText = await (await fetch(`${base}/api/status`)).text();
      const plansText = await (await fetch(`${base}/api/commercial/plans`)).text();
      const dashText = await (await fetch(`${base}/api/commercial/subscribers/dashboard`, {
        headers: { 'x-subscriber-token': sessionToken },
      })).text();
      const adminText = await (await fetch(`${base}/api/commercial/admin/overview`, {
        headers: { 'x-admin-token': adminToken },
      })).text();

      for (const bodyText of [JSON.stringify(onboardJson), statusText, plansText, dashText, adminText]) {
        for (const forbidden of [apiSecret, passphrase, armingPin, masterSecret, licenseSecret, adminToken]) {
          assert.equal(bodyText.includes(forbidden), false, `Secret leaked in HTTP response: ${forbidden}`);
        }
      }

      // Error responses must also scrub any secrets
      const errScrubbed = scrubSecrets(`Failure with ${masterSecret} / ${licenseSecret} / ${adminToken}`, cfg);
      assert.equal(errScrubbed.includes(masterSecret), false);
      assert.equal(errScrubbed.includes(licenseSecret), false);
      assert.equal(errScrubbed.includes(adminToken), false);

      // Flush WAL to main SQLite file and close before inspecting raw bytes
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      await srv.stop();
      store.close();
    }

    try {
      const filesToInspect = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(p => fs.existsSync(p));
      assert.ok(filesToInspect.includes(dbPath));
      for (const f of filesToInspect) {
        const raw = fs.readFileSync(f).toString('utf8');
        for (const secret of [apiSecret, passphrase, armingPin, sessionToken, masterSecret, licenseSecret, adminToken]) {
          assert.equal(raw.includes(secret), false, `Plaintext secret found on disk in ${path.basename(f)}`);
        }
      }
      const mainRaw = fs.readFileSync(dbPath).toString('utf8');
      assert.equal(mainRaw.includes('okx_****9f2a'), true, 'Masked key should be stored in subscriber_credentials_enc');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('2. OKX ctVal & tickSz vs Binance stepSize & minNotionalUsdt Across $60 / $1,500 / $25,000', () => {
  it('classifies MICRO ($60), STANDARD ($1,500), PRO_WHALE ($25,000) and computes exact contract/lot sizing', () => {
    assert.equal(classifyCapitalBracket(60).bracket, 'MICRO');
    assert.equal(classifyCapitalBracket(1500).bracket, 'STANDARD');
    assert.equal(classifyCapitalBracket(25000).bracket, 'PRO_WHALE');

    // OKX BTC-USDT-SWAP default specs check (ctVal=0.01, lotSz=0.01, tickSz=0.1)
    assert.equal(OKX_SWAP_DEFAULT_SPECS['BTC-USDT-SWAP'].ctVal, 0.01);
    assert.equal(OKX_SWAP_DEFAULT_SPECS['BTC-USDT-SWAP'].tickSz, 0.1);
    assert.equal(BINANCE_USDM_DEFAULT_SPECS.BTCUSDT.stepSize, 0.001);
    assert.equal(BINANCE_USDM_DEFAULT_SPECS.BTCUSDT.minNotionalUsdt, 100);

    // 1) $60 MICRO account
    // Target notional = 60 * 1% / 2% = $30.
    // OKX BTC-USDT-SWAP: 1 contract = 0.01 BTC ($900), minSz = 0.01 ($9) => 0.03 contracts ($27) -> feasible
    const okxMicroBtc = computeExchangeOrderSizing({
      exchange: 'OKX',
      symbol: 'BTCUSDT.P',
      side: 1,
      entryPrice: 90000.14,
      stopPrice: 88200.06,
      targetPrice: 92250.04,
      equityUsdt: 60,
      riskPct: 1.0,
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
    });
    assert.equal(okxMicroBtc.feasible, true);
    assert.equal(okxMicroBtc.contractsSz, 0.03);
    assert.equal(okxMicroBtc.baseCoinQty, 0.0003);
    assert.equal(okxMicroBtc.szOrQtyString, '0.03');
    assert.equal(okxMicroBtc.tickEntryPx, 90000.1);
    assert.equal(okxMicroBtc.tickSlPx, 88200.1);

    // Ultra-tiny $15 account falls below OKX 0.01 contract minSz ($9 at $90k BTC)
    const okxTinyBtc = computeExchangeOrderSizing({
      exchange: 'OKX',
      symbol: 'BTCUSDT.P',
      side: 1,
      entryPrice: 90000,
      stopPrice: 88200,
      targetPrice: 92250,
      equityUsdt: 15,
      riskPct: 1.0,
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
    });
    assert.equal(okxTinyBtc.feasible, false);
    assert.equal(okxTinyBtc.skipReason, 'BELOW_OKX_MIN_SZ');

    // Binance BTCUSDT on $60 MICRO ($30 target notional < minNotionalUsdt=100) must be infeasible,
    // while Binance SOLUSDT ($180 price, minNotionalUsdt=5, stepSize=0.1) -> 0.1 SOL ($18) is feasible
    const binMicroBtc = computeExchangeOrderSizing({
      exchange: 'BINANCE',
      symbol: 'BTCUSDT.P',
      side: 1,
      entryPrice: 90000,
      stopPrice: 88200,
      targetPrice: 92250,
      equityUsdt: 60,
      riskPct: 1.0,
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
    });
    assert.equal(binMicroBtc.feasible, false);
    assert.ok(['BELOW_BINANCE_MIN_QTY', 'BELOW_BINANCE_MIN_NOTIONAL'].includes(binMicroBtc.skipReason));

    const binMicroSol = computeExchangeOrderSizing({
      exchange: 'BINANCE',
      symbol: 'SOLUSDT.P',
      side: 1,
      entryPrice: 180.004,
      stopPrice: 176.404,
      targetPrice: 184.504,
      equityUsdt: 60,
      riskPct: 1.0,
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
    });
    assert.equal(binMicroSol.feasible, true);
    assert.equal(binMicroSol.szOrQtyString, '0.1');
    assert.ok(binMicroSol.notionalUsdt >= 5);

    // 2) $1,500 STANDARD account -> target notional $750
    const okxStdBtc = computeExchangeOrderSizing({
      exchange: 'OKX',
      symbol: 'BTCUSDT.P',
      side: 1,
      entryPrice: 90000,
      stopPrice: 88200,
      targetPrice: 92250,
      equityUsdt: 1500,
      riskPct: 1.0,
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
    });
    assert.equal(okxStdBtc.feasible, true);
    assert.equal(okxStdBtc.contractsSz, 0.83);
    assert.equal(okxStdBtc.baseCoinQty, 0.0083);

    const binStdBtc = computeExchangeOrderSizing({
      exchange: 'BINANCE',
      symbol: 'BTCUSDT.P',
      side: 1,
      entryPrice: 90000,
      stopPrice: 88200,
      targetPrice: 92250,
      equityUsdt: 1500,
      riskPct: 1.0,
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
    });
    assert.equal(binStdBtc.feasible, true);
    assert.equal(binStdBtc.szOrQtyString, '0.008');

    // 3) $25,000 PRO_WHALE account (1.25% risk -> $312.50 risk -> $15,625 target notional)
    const okxWhaleBtc = computeExchangeOrderSizing({
      exchange: 'OKX',
      symbol: 'BTCUSDT.P',
      side: 1,
      entryPrice: 90000,
      stopPrice: 88200,
      targetPrice: 92250,
      equityUsdt: 25000,
      riskPct: 1.25,
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
    });
    assert.equal(okxWhaleBtc.feasible, true);
    assert.equal(okxWhaleBtc.contractsSz, 17.36);
    assert.equal(okxWhaleBtc.baseCoinQty, 0.1736);
    assert.ok(okxWhaleBtc.estimatedLiqPx < okxWhaleBtc.tickEntryPx);

    const binWhaleBtc = computeExchangeOrderSizing({
      exchange: 'BINANCE',
      symbol: 'BTCUSDT.P',
      side: 1,
      entryPrice: 90000,
      stopPrice: 88200,
      targetPrice: 92250,
      equityUsdt: 25000,
      riskPct: 1.25,
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
    });
    assert.equal(binWhaleBtc.feasible, true);
    assert.equal(binWhaleBtc.szOrQtyString, '0.173');
    assert.ok(binWhaleBtc.notionalUsdt >= 15500);
  });
});

describe('3. All 7 Commercial Guardrails, Multi-Tenant clOrdId Isolation & Crash Recovery', () => {
  it('hard-blocks WITHDRAW keys, tampered/expired/Starter licenses, cap overflow, CB/Kill trips, wrong PIN & weak LIVE key', async () => {
    const tmp = makeTmpDir('tt-v10-guard-');
    const dbPath = path.join(tmp, 'guard.sqlite');
    const licSecret = 'guardrail-license-secret-v10-test';
    const master32 = 'guardrail-master-key-32chars-minimum-ok!';
    const baseCfg = {
      repoRoot: REPO_ROOT,
      exchange: 'OKX',
      executionMode: 'PAPER',
      dryRun: true,
      riskTier: 'SAFE_75WR',
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
      liveConfirmToken: 'live-confirm-tok-guard',
      commercialMasterKey: master32,
      commercialLicenseSecret: licSecret,
    };
    const store = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const engine = new CommercialPlatformEngine({ store, config: baseCfg });

    try {
      // Guardrail 2 (unit + onboarding): WITHDRAW permission hard-blocked
      assert.equal(
        inspectApiKeyPermissions({ exchange: 'OKX', rawPermissionPayload: { perm: 'read_only,trade,withdraw' } }).safeForAutoTrade,
        false,
      );
      assert.equal(
        inspectApiKeyPermissions({ exchange: 'BINANCE', rawPermissionPayload: { enableWithdrawals: true, enableFutures: true, enableReading: true } }).safeForAutoTrade,
        false,
      );

      const proLic = issueLicenseKey({
        planId: 'PRO_AUTO_TRADER',
        subscriberRef: 'pro@buyer.io',
        durationDays: 30,
        signingSecret: licSecret,
      }).licenseKey;

      await assert.rejects(
        () => engine.onboardSubscriber({
          name: 'Withdraw User',
          licenseKey: proLic,
          exchange: 'OKX',
          apiKey: 'okx_bad_key_1234',
          apiSecret: 'okx_bad_sec_1234',
          rawPermissionPayload: { perm: 'read_only,trade,withdraw' },
          armingPin: '1234',
          executionMode: 'DEMO_AUTO_TRADE',
        }),
        /WITHDRAW permission enabled/,
      );

      // Guardrail 1: tampered signature, expired license, and STARTER_SCAN_SIGNAL auto-trade block
      const parts = proLic.split('.');
      const tamperedLic = `${parts[0]}.${parts[1]}.${flipFirstHexNibble(parts[2])}`;
      assert.equal(verifyLicenseKey(tamperedLic, licSecret).reason, 'INVALID_SIGNATURE');
      assert.equal(verifyLicenseKey(proLic, licSecret, Date.now() + 31 * 86400 * 1000).reason, 'LICENSE_EXPIRED');

      const starterLic = issueLicenseKey({
        planId: 'STARTER_SCAN_SIGNAL',
        subscriberRef: 'starter@buyer.io',
        durationDays: 30,
        signingSecret: licSecret,
      }).licenseKey;
      await assert.rejects(
        () => engine.onboardSubscriber({
          name: 'Starter Attempt',
          licenseKey: starterLic,
          armingPin: '1234',
          executionMode: 'DEMO_AUTO_TRADE',
        }),
        /does not permit executionMode=DEMO_AUTO_TRADE/,
      );

      // Onboard valid PRO subscriber for Guardrails 3, 4, 5, 6, 7
      let equity = 5000;
      let orderCalls = 0;
      const mockClient = {
        async getAccountHealth() {
          return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: equity, availEqUsdt: equity, openPositions: [] };
        },
        async placePostOnlyEntry() {
          orderCalls += 1;
          return { dryRun: false, exchange: 'OKX', data: [{ ordId: `ord_${orderCalls}`, sCode: '0' }] };
        },
        async placeReduceOnlySlTp() {
          orderCalls += 1;
          return { dryRun: false, exchange: 'OKX', data: [{ algoId: `algo_${orderCalls}`, sCode: '0' }] };
        },
        async cancelOrder() {
          return { dryRun: false, exchange: 'OKX', data: [{ sCode: '0' }] };
        },
      };

      const overlayOverrides = {
        'BTCUSDT.P': makeFakeActiveOverlay({ side: 1, price: 90000, barTime: 1765100000 }),
      };

      const subRes = await engine.onboardSubscriber({
        name: 'Guardrail Buyer',
        licenseKey: proLic,
        exchange: 'OKX',
        simulated: true,
        apiKey: 'okx_demo_guard_9f2a',
        apiSecret: 'okx_demo_guard_sec',
        passphrase: 'pass',
        rawPermissionPayload: { perm: 'read_only,trade' },
        armingPin: '5678',
        executionMode: 'DEMO_AUTO_TRADE',
        maxDailyLossPct: 5.0,
        maxDdKillPct: 20.0,
        clientOverride: mockClient,
        overlayOverrides,
      });
      const subId = subRes.subscriber.subscriberId;

      // Guardrail 3: wrong armingPin must block both mode change and cycle
      assert.throws(
        () => engine.updateSubscriberMode(subId, { executionMode: 'DEMO_AUTO_TRADE', armingPin: '0000' }),
        /Invalid armingPin/,
      );
      const badPinCycle = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '0000',
        clientOverride: mockClient,
        overlayOverrides,
      });
      assert.equal(badPinCycle.executed, false);
      assert.equal(badPinCycle.blockedReason, 'GUARDRAIL_3_INVALID_ARMING_PIN');
      assert.equal(orderCalls, 0);

      // Guardrail 6: account equity > PRO plan maxCapitalUsdt (25,000) must block auto-trade
      equity = 30000;
      const capBlock = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '5678',
        clientOverride: mockClient,
        overlayOverrides,
      });
      assert.equal(capBlock.executed, false);
      assert.equal(capBlock.blockedReason, 'GUARDRAIL_6_EQUITY_EXCEEDS_PLAN_MAX_25000');
      assert.equal(orderCalls, 0);

      // Guardrail 4: Daily Loss Circuit Breaker trips when equity drops >= 5% in UTC day
      // Note: high water & day start were initialized at $5,000 during onboard, then climbed to $30,000;
      // reset clean state via updateSubscriberMode(resetTrips: true) at $5,000 first so we test CB vs Kill cleanly!
      equity = 5000;
      await engine.scanSubscriberAccount(subId, { simulatedEquityUsdt: 5000, overlayOverrides });
      engine.updateSubscriberMode(subId, { executionMode: 'DEMO_AUTO_TRADE', armingPin: '5678', resetTrips: true });
      const ordersBeforeCb = orderCalls;
      // Drop 6% ($5,000 -> $4,700): trips Daily Loss CB (>= 5%) without tripping 20% Kill Switch
      equity = 4700;
      const cbTrip = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '5678',
        clientOverride: mockClient,
        overlayOverrides,
      });
      assert.equal(cbTrip.executed, false);
      assert.equal(cbTrip.blockedReason, 'GUARDRAIL_4_CIRCUIT_BREAKER_TRIPPED');
      assert.equal(cbTrip.riskState.circuitBreakerTripped, true);
      assert.equal(cbTrip.riskState.killSwitchTripped, false);
      assert.equal(orderCalls, ordersBeforeCb);

      // Guardrail 5: High-Water MaxDD Kill Switch trips on >= 20% drawdown ($10,000 -> $7,800 = 22% DD)
      engine.updateSubscriberMode(subId, { executionMode: 'DEMO_AUTO_TRADE', armingPin: '5678', resetTrips: true });
      await engine.scanSubscriberAccount(subId, { simulatedEquityUsdt: 10000, overlayOverrides });
      equity = 7800;
      const killTrip = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '5678',
        clientOverride: mockClient,
        overlayOverrides,
      });
      assert.equal(killTrip.executed, false);
      assert.ok(['GUARDRAIL_4_CIRCUIT_BREAKER_TRIPPED', 'GUARDRAIL_5_KILL_SWITCH_TRIPPED'].includes(killTrip.blockedReason));
      assert.equal(killTrip.riskState.killSwitchTripped, true);
      // Even after equity recovers to $9,900, kill switch remains tripped until operator reset
      equity = 9900;
      const killSticky = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '5678',
        clientOverride: mockClient,
        overlayOverrides,
      });
      assert.equal(killSticky.executed, false);
      assert.equal(killSticky.riskState.killSwitchTripped, true);

      // Weak COMMERCIAL_MASTER_KEY (< 32 chars) must fail LIVE_AUTO_TRADE activation
      const weakEngine = new CommercialPlatformEngine({
        store,
        config: { ...baseCfg, commercialMasterKey: 'only-20-chars-weak!' },
      });
      assert.throws(
        () => weakEngine.updateSubscriberMode(subId, { executionMode: 'LIVE_AUTO_TRADE', armingPin: '5678' }),
        /COMMERCIAL_MASTER_KEY \(>= 32 chars\) required for LIVE_AUTO_TRADE/,
      );

      // Guardrail 7: multi-tenant alphanumeric clOrdId isolation + crash recovery
      const cid1 = makeTenantClientOrderId({ subscriberId: 'tenant_alpha', exchange: 'OKX', symbol: 'BTCUSDT.P', timeframe: '1h', barTime: 1765100000, side: 1, leg: 'E' });
      const cid2 = makeTenantClientOrderId({ subscriberId: 'tenant_beta', exchange: 'OKX', symbol: 'BTCUSDT.P', timeframe: '1h', barTime: 1765100000, side: 1, leg: 'E' });
      assert.match(cid1, ALPHANUM_CLORDID_RE);
      assert.match(cid2, ALPHANUM_CLORDID_RE);
      assert.notEqual(cid1, cid2);

      const cStore = new CommercialStore(store);
      cStore.upsertSubscriberOrderLog({
        clientOrderId: 't10crash999BTC1hLE1234567890ab',
        subscriberId: subId,
        exchange: 'OKX',
        symbol: 'BTCUSDT.P',
        mode: 'DEMO_AUTO_TRADE',
        orderType: 'post_only',
        side: 'buy',
        price: 90000,
        qty: '0.05',
        reduceOnly: false,
        status: 'SUBMITTING',
      });
      assert.equal(cStore.recoverInterruptedSubscriberOrders(), 1);
      assert.equal(cStore.findSubscriberOrder('t10crash999BTC1hLE1234567890ab').status, 'INTERRUPTED');
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('4. Full HTTP Loopback E2E Workflow, Real OkxClient Demo Routing & Zero-XSS Audit', () => {
  it('passes static Zero-XSS audit on standalone/public/*, loopback host & .env gitignore checks', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'standalone/public/index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(REPO_ROOT, 'standalone/public/app.js'), 'utf8');
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');

    assert.equal(html.includes('commercial-hub-section'), true);
    assert.equal(/<\s*script[^>]*>[^<\s]/i.test(html), false, 'Inline <script> code forbidden');
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'Inline on*= handlers forbidden');
    for (const danger of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.equal(appJs.includes(danger), false, `Forbidden DOM XSS sink in app.js: ${danger}`);
    }
    assert.equal(appJs.includes('createElement'), true);
    assert.equal(appJs.includes('textContent'), true);

    assert.equal(gitignore.includes('.env'), true);
    assert.equal(envExample.includes('COMMERCIAL_MASTER_KEY='), true);
    assert.equal(envExample.includes('EXECUTION_MODE=PAPER'), true);
    assert.equal(envExample.includes('DRY_RUN=true'), true);

    const defCfg = loadConfig({ cwd: REPO_ROOT, useProcessEnv: false });
    assert.equal(defCfg.host, '127.0.0.1');
    assert.equal(defCfg.executionMode, 'PAPER');
    assert.equal(defCfg.dryRun, true);
    assert.equal(redactConfig(defCfg).commercial.masterKeyConfigured, false);
  });

  it('runs complete Seller->Buyer HTTP loopback E2E + signed OKX Demo post_only/OCO once + IDEMPOTENT_SKIP on repeat', async () => {
    const tmp = makeTmpDir('tt-v10-e2e-');
    const httpCalls = [];
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        RISK_TIER: 'SAFE_75WR',
        COMMERCIAL_MASTER_KEY: 'e2e-commercial-vault-master-key-32chars!!',
        COMMERCIAL_LICENSE_SECRET: 'e2e-commercial-license-secret-key',
        COMMERCIAL_ADMIN_TOKEN: 'e2e-commercial-admin-token-99',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'e2e.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);

    const buildMockOkx = ({ creds, maxLeverageCap, maxOrderUsdt }) => new OkxClient({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      passphrase: creds.passphrase,
      simulated: true,
      dryRun: false,
      executionMode: 'LIVE_ARMED',
      liveConfirmToken: 'tenant_e2e_okx_tok',
      maxLeverageCap,
      maxOrderUsdt,
      fetchImpl: async (url, init = {}) => {
        const headers = init.headers || {};
        const parsedBody = init.body ? JSON.parse(init.body) : null;
        if (String(url).includes('/api/v5/account/balance')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: '0',
              data: [{ totalEq: '5000', details: [{ ccy: 'USDT', availEq: '4800' }] }],
            }),
          };
        }
        if (String(url).includes('/api/v5/account/positions')) {
          return { ok: true, status: 200, json: async () => ({ code: '0', data: [] }) };
        }
        httpCalls.push({ url: String(url), headers, body: parsedBody });
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: '0', data: [{ ordId: `okxOrd${httpCalls.length}`, algoId: `okxAlgo${httpCalls.length}`, sCode: '0' }] }),
        };
      },
    });

    const srv = createStandaloneServer({
      config: cfg,
      store,
      runtimeSpecs,
      exchangeClientFactory: ({ creds, maxLeverageCap, maxOrderUsdt }) => buildMockOkx({ creds, maxLeverageCap, maxOrderUsdt }),
    });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      // 1) Admin issues TT10 license
      const licJson = await (await fetch(`${base}/api/commercial/admin/licenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': 'e2e-commercial-admin-token-99' },
        body: JSON.stringify({ planId: 'PRO_AUTO_TRADER', subscriberRef: 'e2e@buyer.io', durationDays: 30 }),
      })).json();
      assert.equal(licJson.ok, true);
      assert.ok(licJson.licenseKey.startsWith('TT10.'));

      // 2) Buyer onboards OKX Demo key (read_only,trade)
      const onboardJson = await (await fetch(`${base}/api/commercial/subscribers/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'E2E OKX Buyer',
          email: 'e2e@buyer.io',
          licenseKey: licJson.licenseKey,
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_e2e_demo_key_44aa',
          apiSecret: 'okx-e2e-demo-secret-key',
          passphrase: 'okx-e2e-passphrase',
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin: '2468',
          executionMode: 'SCAN_AND_SIGNAL_ONLY',
        }),
      })).json();
      assert.equal(onboardJson.ok, true);
      assert.equal(onboardJson.keyMask, 'okx_****44aa');
      const subId = onboardJson.subscriber.subscriberId;
      const subTok = onboardJson.sessionToken;

      // 3) Buyer scans $5,000 account -> receives PRO_WHALE $-sized signal tickets
      const scanJson = await (await fetch(`${base}/api/commercial/subscribers/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': subTok },
        body: JSON.stringify({ simulatedEquityUsdt: 5000 }),
      })).json();
      assert.equal(scanJson.ok, true);
      assert.equal(scanJson.bracket.bracket, 'PRO_WHALE');
      assert.ok(Array.isArray(scanJson.tickets) && scanJson.tickets.length >= 4);
      assert.ok(scanJson.tickets.some(t => t.feasible === true && Number(t.notional_usdt) > 0));

      // 4) Buyer switches to DEMO_AUTO_TRADE with valid armingPin & triggers HTTP run-cycle
      const modeJson = await (await fetch(`${base}/api/commercial/subscribers/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': subTok },
        body: JSON.stringify({ executionMode: 'DEMO_AUTO_TRADE', armingPin: '2468' }),
      })).json();
      assert.equal(modeJson.ok, true);
      assert.equal(modeJson.subscriber.executionMode, 'DEMO_AUTO_TRADE');

      const httpCycleJson = await (await fetch(`${base}/api/commercial/subscribers/run-cycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': subTok },
        body: JSON.stringify({ armingPin: '2468', simulatedEquityUsdt: 5000 }),
      })).json();
      assert.equal(httpCycleJson.ok, true);
      assert.equal(httpCycleJson.executed, true);
      assert.equal(httpCycleJson.mode, 'DEMO_AUTO_TRADE');

      // 5) Deterministic active-signal order placement check via CommercialPlatformEngine sharing the same SQLite store
      //    proving real signed OKX Demo `post_only` + `oco` `reduceOnly: true` ONCE and `IDEMPOTENT_SKIP` on repeat
      const callsBeforeDeterministic = httpCalls.length;
      const detEngine = new CommercialPlatformEngine({
        store,
        config: { ...cfg, liveConfirmToken: 'tenant_e2e_okx_tok' },
        runtimeSpecs,
        exchangeClientFactory: ({ creds, maxLeverageCap, maxOrderUsdt }) => buildMockOkx({ creds, maxLeverageCap, maxOrderUsdt }),
      });
      const detOverlays = { 'BTCUSDT.P': makeFakeActiveOverlay({ side: 1, price: 90000, barTime: 1765200000 }) };

      const firstRun = await detEngine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '2468',
        simulatedEquityUsdt: 5000,
        overlayOverrides: detOverlays,
      });
      assert.equal(firstRun.executed, true);
      assert.equal(firstRun.actions.filter(a => a.action === 'SUBMITTED').length, 1);
      assert.equal(firstRun.actions.filter(a => a.action === 'SL_TP_ATTACHED_TO_ENTRY').length, 1);
      assert.equal(httpCalls.length - callsBeforeDeterministic, 1);

      const entryCall = httpCalls[callsBeforeDeterministic];
      assert.equal(entryCall.url.endsWith('/api/v5/trade/order'), true);
      assert.equal(entryCall.headers['x-simulated-trading'], '1');
      assert.ok(entryCall.headers['OK-ACCESS-SIGN']);
      assert.equal(entryCall.body.ordType, 'post_only');
      assert.equal(entryCall.body.side, 'buy');
      assert.match(entryCall.body.clOrdId, ALPHANUM_CLORDID_RE);
      assert.ok(Array.isArray(entryCall.body.attachAlgoOrds) && entryCall.body.attachAlgoOrds.length === 1);
      const attachAlgo = entryCall.body.attachAlgoOrds[0];
      assert.match(attachAlgo.attachAlgoClOrdId, ALPHANUM_CLORDID_RE);
      assert.ok(Number(attachAlgo.slTriggerPx) > 0);
      assert.ok(Number(attachAlgo.tpTriggerPx) > 0);
      assert.equal(attachAlgo.slOrdPx, '-1');
      assert.equal(attachAlgo.tpOrdPx, '-1');

      const slTpAction = firstRun.actions.find(a => a.action === 'SL_TP_ATTACHED_TO_ENTRY');
      assert.ok(slTpAction);
      assert.match(slTpAction.clientOrderId, ALPHANUM_CLORDID_RE);
      assert.equal(slTpAction.clientOrderId, attachAlgo.attachAlgoClOrdId);

      // Repeat exact cycle -> IDEMPOTENT_SKIP with zero extra exchange calls
      const repeatRun = await detEngine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '2468',
        simulatedEquityUsdt: 5000,
        overlayOverrides: detOverlays,
      });
      assert.equal(repeatRun.executed, true);
      assert.equal(repeatRun.actions.some(a => a.action === 'IDEMPOTENT_SKIP'), true);
      assert.equal(httpCalls.length - callsBeforeDeterministic, 1);

      // 6) Verify dashboard over HTTP shows persisted orders without secret leakage
      const dashJson = await (await fetch(`${base}/api/commercial/subscribers/dashboard`, {
        headers: { 'x-subscriber-token': subTok },
      })).json();
      assert.equal(dashJson.ok, true);
      assert.ok(dashJson.orders.some(o => o.client_order_id === entryCall.body.clOrdId && o.status === 'SUBMITTED'));
      assert.ok(dashJson.orders.some(o => o.client_order_id === slTpAction.clientOrderId && o.order_type === 'oco_attached' && o.status === 'ATTACHED_TO_ENTRY' && o.reduceOnly === true));
      assert.equal(JSON.stringify(dashJson).includes('okx-e2e-demo-secret-key'), false);
      assert.equal(JSON.stringify(dashJson).includes('okx-e2e-passphrase'), false);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
