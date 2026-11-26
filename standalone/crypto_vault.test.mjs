import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVaultMasterKey,
  maskApiKey,
  encryptCredentials,
  decryptCredentials,
} from './crypto_vault.mjs';
import {
  OKX_SWAP_DEFAULT_SPECS,
  BINANCE_USDM_DEFAULT_SPECS,
  fetchLiveOkxSwapSpecs,
  getInstrumentSpec,
  roundToStep,
  computeExchangeOrderSizing,
  inspectApiKeyPermissions,
} from './instrument_specs.mjs';
import {
  COMMERCIAL_PLANS,
  resolveLicenseSigningSecret,
  issueLicenseKey,
  verifyLicenseKey,
} from './license_issuer.mjs';

function near(actual, expected, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} != ${expected}`);
}

test('crypto_vault: resolveVaultMasterKey enforces >=32 chars for LIVE_AUTO_TRADE and caches ephemeral key in non-live mode', () => {
  assert.throws(
    () => resolveVaultMasterKey({}, { forLiveAutoTrade: true }),
    /COMMERCIAL_MASTER_KEY/,
  );
  assert.throws(
    () => resolveVaultMasterKey({ commercialMasterKey: 'short_key_under_32_chars' }, { forLiveAutoTrade: true }),
    /COMMERCIAL_MASTER_KEY/,
  );

  const liveKey = resolveVaultMasterKey(
    { commercialMasterKey: '0123456789abcdef0123456789abcdef' },
    { forLiveAutoTrade: true },
  );
  assert.equal(liveKey.ephemeral, false);
  assert.equal(liveKey.key.length, 32);

  const eph1 = resolveVaultMasterKey({});
  const eph2 = resolveVaultMasterKey({ commercialMasterKey: 'too_short' });
  assert.equal(eph1.ephemeral, true);
  assert.equal(eph1.key, eph2.key);
  assert.equal(eph1.key.length, 64); // 32 bytes hex

  const devExplicit = resolveVaultMasterKey({ commercialMasterKey: 'explicit_16plus_' });
  assert.equal(devExplicit.ephemeral, false);
  assert.equal(devExplicit.key, 'explicit_16plus_');
});

test('crypto_vault: maskApiKey and AES-256-GCM encrypt/decrypt with AAD binding and tamper detection', () => {
  assert.equal(maskApiKey('okx_live_key_12349f2a'), 'okx_****9f2a');
  assert.equal(maskApiKey('abcd'), '****');
  assert.equal(maskApiKey(''), '****');
  assert.equal(maskApiKey('123456'), '****56');

  const creds = {
    apiKey: 'okx_live_secret_prefix_9f2a',
    apiSecret: 'super-secret-value-do-not-leak',
    passphrase: 'pass-phrase-value',
  };
  const masterKey = 'my-32-byte-master-vault-key-value!';
  const aad = 'sub_123|OKX';

  const env = encryptCredentials(creds, masterKey, aad);
  assert.equal(env.version, 1);
  assert.equal(env.alg, 'aes-256-gcm');
  assert.equal(env.saltHex.length, 32);
  assert.equal(env.ivHex.length, 24);
  assert.equal(env.tagHex.length, 32);
  assert.equal(env.keyMask, 'okx_****9f2a');
  assert.ok(!JSON.stringify(env).includes(creds.apiSecret));

  const dec = decryptCredentials(env, masterKey, aad);
  assert.deepEqual(dec, creds);

  // Wrong AAD, wrong key, tampered tag, tampered ciphertext, tampered salt, tampered IV must throw
  assert.throws(() => decryptCredentials(env, masterKey, 'sub_999|OKX'));
  assert.throws(() => decryptCredentials(env, 'wrong-master-key-0000000000000000', aad));
  const flipFirst = hex => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
  assert.throws(() => decryptCredentials({ ...env, tagHex: flipFirst(env.tagHex) }, masterKey, aad));
  assert.throws(() => decryptCredentials({ ...env, ciphertextHex: flipFirst(env.ciphertextHex) }, masterKey, aad));
  assert.throws(() => decryptCredentials({ ...env, saltHex: flipFirst(env.saltHex) }, masterKey, aad));
  assert.throws(() => decryptCredentials({ ...env, ivHex: flipFirst(env.ivHex) }, masterKey, aad));
});

test('instrument_specs: roundToStep handles floating point cleanly across floor/ceil/round', () => {
  assert.equal(roundToStep(0.03, 0.01, 'floor'), 0.03);
  assert.equal(roundToStep(0.039999, 0.01, 'floor'), 0.03);
  assert.equal(roundToStep(0.030001, 0.01, 'ceil'), 0.04);
  assert.equal(roundToStep(58660.54, 0.1, 'round'), 58660.5);
  assert.equal(roundToStep(12.999, 1, 'floor'), 12);
  assert.equal(roundToStep(1.23456, 0.001, 'floor'), 1.234);
});

test('instrument_specs: OKX & Binance defaults, symbol normalization, and fetchLiveOkxSwapSpecs', async () => {
  assert.equal(OKX_SWAP_DEFAULT_SPECS['BTC-USDT-SWAP'].ctVal, 0.01);
  assert.equal(OKX_SWAP_DEFAULT_SPECS['BNB-USDT-SWAP'].lotSz, 1);
  assert.equal(BINANCE_USDM_DEFAULT_SPECS.BTCUSDT.minNotionalUsdt, 100);

  for (const sym of ['BTCUSDT.P', 'BTC', 'BTC-USDT-SWAP', 'BTCUSDT']) {
    assert.equal(getInstrumentSpec('OKX', sym).instId, 'BTC-USDT-SWAP');
    assert.equal(getInstrumentSpec('BINANCE', sym).instId, 'BTCUSDT');
  }

  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      code: '0',
      data: [
        { instId: 'BTC-USDT-SWAP', ctVal: '0.01', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', state: 'live' },
        { instId: 'DOGE-USDT-SWAP', ctVal: '100', lotSz: '1', minSz: '1', tickSz: '0.00001', state: 'live' },
      ],
    }),
  });
  const liveMap = await fetchLiveOkxSwapSpecs(fakeFetch);
  assert.equal(liveMap.size, 2);
  assert.equal(getInstrumentSpec('OKX', 'DOGEUSDT.P', liveMap).ctVal, 100);
});

test('instrument_specs: computeExchangeOrderSizing computes OKX SWAP contracts, Binance USD-M qty, min checks, and liq price', () => {
  // OKX BTC: equity=1000, risk=1% -> budget=$10; entry=50000, stop=49500 (1% stopDist) -> targetNotional=$1000
  // 1 contract = 0.01 BTC = $500 -> 2.00 contracts
  const okxExact = computeExchangeOrderSizing({
    exchange: 'OKX',
    symbol: 'BTCUSDT.P',
    side: 1,
    entryPrice: 50000.0,
    stopPrice: 49500.0,
    targetPrice: 51000.0,
    equityUsdt: 1000,
    riskPct: 1.0,
    strategyLev: 2.0,
    maxLeverageCap: 3.0,
    maxOrderUsdt: 5000,
  });
  assert.equal(okxExact.feasible, true);
  assert.equal(okxExact.skipReason, null);
  assert.equal(okxExact.szOrQtyString, '2.00');
  near(okxExact.contractsSz, 2.0);
  near(okxExact.baseCoinQty, 0.02);
  near(okxExact.notionalUsdt, 1000);
  near(okxExact.marginRequiredUsdt, 500);
  near(okxExact.estimatedRiskUsdt, 10);
  near(okxExact.estimatedProfitUsdt, 20);
  near(okxExact.estimatedFeeUsdt, 0.4);
  // Long 2x liq: 50000 * (1 - (0.5 - 0.005)) = 50000 * 0.505 = 25250
  near(okxExact.estimatedLiqPx, 25250.0);

  // Tick rounding + floor behavior on fractional entry/SL/TP
  const okxTick = computeExchangeOrderSizing({
    exchange: 'OKX',
    symbol: 'BTCUSDT.P',
    side: 1,
    entryPrice: 50000.04,
    stopPrice: 49500.02,
    targetPrice: 51000.08,
    equityUsdt: 1000,
    riskPct: 1.0,
    strategyLev: 2.0,
    maxLeverageCap: 3.0,
    maxOrderUsdt: 5000,
  });
  assert.equal(okxTick.feasible, true);
  assert.equal(okxTick.szOrQtyString, '1.99');
  assert.equal(okxTick.tickEntryPx, 50000.0);
  assert.equal(okxTick.tickSlPx, 49500.0);
  assert.equal(okxTick.tickTpPx, 51000.1);

  // OKX BNB lotSz=1, ctVal=0.01: entry=600 -> 1 contract = $6. Tiny account ($5 -> below minSz=1)
  const okxTooSmall = computeExchangeOrderSizing({
    exchange: 'OKX',
    symbol: 'BNBUSDT.P',
    side: -1,
    entryPrice: 600,
    stopPrice: 630, // 5%
    equityUsdt: 5,
    riskPct: 1.0,
  });
  assert.equal(okxTooSmall.feasible, false);
  assert.equal(okxTooSmall.skipReason, 'BELOW_OKX_MIN_SZ');

  // Binance BTCUSD-M: minNotionalUsdt=100, stepSize=0.001
  const binanceOk = computeExchangeOrderSizing({
    exchange: 'BINANCE',
    symbol: 'BTCUSDT.P',
    side: -1,
    entryPrice: 50000,
    stopPrice: 50500, // 1%
    targetPrice: 49000,
    equityUsdt: 1000,
    riskPct: 1.0,
    strategyLev: 2.0,
    maxLeverageCap: 3.0,
    maxOrderUsdt: 5000,
  });
  assert.equal(binanceOk.feasible, true);
  assert.equal(binanceOk.szOrQtyString, '0.020');
  near(binanceOk.baseCoinQty, 0.02);
  near(binanceOk.notionalUsdt, 1000);
  // Short 2x liq: 50000 * (1 + (0.5 - 0.005)) = 50000 * 1.495 = 74750
  near(binanceOk.estimatedLiqPx, 74750);

  // Binance BTC below minNotionalUsdt=100 (e.g., $60 notional -> 0.001 BTC = $50 < $100)
  const binanceSmall = computeExchangeOrderSizing({
    exchange: 'BINANCE',
    symbol: 'BTCUSDT',
    side: 1,
    entryPrice: 50000,
    stopPrice: 52500, // 5%
    equityUsdt: 300,
    riskPct: 1.0, // budget $3 -> target $60 -> 0.001 BTC = $50 < $100
  });
  assert.equal(binanceSmall.feasible, false);
  assert.equal(binanceSmall.skipReason, 'BELOW_BINANCE_MIN_NOTIONAL');
});

test('instrument_specs: inspectApiKeyPermissions hard-blocks withdrawal permission on both OKX and Binance', () => {
  const okxSafe = inspectApiKeyPermissions({
    exchange: 'OKX',
    rawPermissionPayload: [{ perm: 'read_only,trade' }],
  });
  assert.equal(okxSafe.safeForAutoTrade, true);
  assert.equal(okxSafe.hasWithdrawPermission, false);
  assert.equal(okxSafe.canTrade, true);
  assert.equal(okxSafe.canRead, true);

  const okxWithdraw = inspectApiKeyPermissions({
    exchange: 'OKX',
    rawPermissionPayload: { perm: 'read_only,trade,withdraw' },
  });
  assert.equal(okxWithdraw.safeForAutoTrade, false);
  assert.equal(okxWithdraw.hasWithdrawPermission, true);

  const okxReadOnly = inspectApiKeyPermissions({
    exchange: 'OKX',
    rawPermissionPayload: { perm: 'read_only' },
  });
  assert.equal(okxReadOnly.safeForAutoTrade, false);
  assert.equal(okxReadOnly.canTrade, false);

  const binSafe = inspectApiKeyPermissions({
    exchange: 'BINANCE',
    rawPermissionPayload: { enableReading: true, enableFutures: true, enableWithdrawals: false },
  });
  assert.equal(binSafe.safeForAutoTrade, true);

  const binWithdraw = inspectApiKeyPermissions({
    exchange: 'BINANCE',
    rawPermissionPayload: { enableReading: true, enableFutures: true, enableWithdrawals: true },
  });
  assert.equal(binWithdraw.safeForAutoTrade, false);
  assert.equal(binWithdraw.hasWithdrawPermission, true);
});

test('license_issuer: plans, issuance, constant-time verification, tamper rejection, and expiry', () => {
  assert.deepEqual(
    Object.keys(COMMERCIAL_PLANS),
    ['STARTER_SCAN_SIGNAL', 'PRO_AUTO_TRADER', 'INSTITUTIONAL_VIP'],
  );
  assert.equal(COMMERCIAL_PLANS.STARTER_SCAN_SIGNAL.priceUsdMonthly, 29);
  assert.equal(COMMERCIAL_PLANS.PRO_AUTO_TRADER.priceUsdMonthly, 79);
  assert.equal(COMMERCIAL_PLANS.INSTITUTIONAL_VIP.priceUsdMonthly, 199);
  assert.ok(Object.isFrozen(COMMERCIAL_PLANS.PRO_AUTO_TRADER));

  const s1 = resolveLicenseSigningSecret({});
  const s2 = resolveLicenseSigningSecret({});
  assert.equal(s1, s2);
  assert.equal(s1.length, 64);

  const secret = resolveLicenseSigningSecret({ commercialLicenseSecret: 'test-commercial-signing-secret' });
  const issued = issueLicenseKey({
    planId: 'PRO_AUTO_TRADER',
    subscriberRef: 'acct_vip_001',
    durationDays: 30,
    maxCapitalUsdtOverride: 50000,
    signingSecret: secret,
  });
  assert.ok(/^TT10\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{24}$/.test(issued.licenseKey));
  assert.equal(issued.payload.maxCapitalUsdt, 50000);

  const ok = verifyLicenseKey(issued.licenseKey, secret, issued.payload.issuedAtMs + 1000);
  assert.equal(ok.valid, true);
  assert.equal(ok.plan.id, 'PRO_AUTO_TRADER');
  assert.equal(ok.payload.subscriberRef, 'acct_vip_001');

  // Expired check
  const expired = verifyLicenseKey(issued.licenseKey, secret, issued.payload.expiresAtMs + 1);
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, 'LICENSE_EXPIRED');

  // Wrong secret & tampered key rejected
  assert.equal(verifyLicenseKey(issued.licenseKey, 'wrong-secret').valid, false);
  const tamperedKey = issued.licenseKey.slice(0, -1) + (issued.licenseKey.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyLicenseKey(tamperedKey, secret).reason, 'INVALID_SIGNATURE');
  assert.equal(verifyLicenseKey('BAD.key.format', secret).reason, 'INVALID_FORMAT');
});
