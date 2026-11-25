import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';
import { StandaloneStore } from './store_sqlite.mjs';
import { COMMERCIAL_PLANS, issueLicenseKey } from './license_issuer.mjs';
import { CommercialStore } from './commercial_store.mjs';
import {
  CommercialPlatformEngine,
  classifyCapitalBracket,
  makeTenantClientOrderId,
} from './commercial_engine.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TEST_MASTER_KEY = 'TestMasterKey32CharsMin_v10Secure!';
const TEST_LICENSE_SECRET = 'TestLicenseSecret_v10_HMAC_Signing';

function makeTempConfig(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v10-comm-'));
  return {
    dir,
    config: {
      repoRoot: REPO_ROOT,
      exchange: 'OKX',
      executionMode: 'PAPER',
      dryRun: true,
      riskTier: 'SAFE_75WR',
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
      liveConfirmToken: 'confirm-live-test-token',
      commercialMasterKey: TEST_MASTER_KEY,
      commercialLicenseSecret: TEST_LICENSE_SECRET,
      ...extra,
    },
  };
}

function makeFakeOverlay(side = 1, px = 90000) {
  return {
    summary: { modelVersion: 'v9.0-WalkForwardEnsemble' },
    regime: { regime: side === 1 ? 'BULL_TREND' : 'BEAR_TREND', trendScore: 0.65 * side, longPriority: side === 1 ? 1 : 0, shortPriority: side === -1 ? 1 : 0 },
    execOptions: { stopAtr: 3.2, minStopPct: 1.4, rewardRisk: 1.25, minLev: 1.5 },
    lastClose: px,
    latestBarTime: 1764000000,
    activeOverlay: {
      status: 'PENDING_LIMIT',
      side,
      signalTime: 1764000000,
      limitPrice: px,
      stop: px - side * (px * 0.02),
      target: px + side * (px * 0.025),
      lev: 1.5,
      probWin: 0.78,
    },
  };
}

describe('CommercialPlatformEngine & CommercialStore v10.0', () => {
  const tmpDirs = [];
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('classifies capital brackets and generates strictly alphanumeric tenant clOrdIds', () => {
    assert.equal(classifyCapitalBracket(80).bracket, 'MICRO');
    assert.equal(classifyCapitalBracket(150).bracket, 'STANDARD');
    assert.equal(classifyCapitalBracket(2000).bracket, 'STANDARD');
    assert.equal(classifyCapitalBracket(5000).bracket, 'PRO_WHALE');

    const idA = makeTenantClientOrderId({ subscriberId: 'sub_alpha_1', exchange: 'OKX', symbol: 'BTCUSDT.P', timeframe: '1h', barTime: 1764000000, side: 1, leg: 'E' });
    const idB = makeTenantClientOrderId({ subscriberId: 'sub_beta_2', exchange: 'OKX', symbol: 'BTCUSDT.P', timeframe: '1h', barTime: 1764000000, side: 1, leg: 'E' });
    assert.match(idA, /^[A-Za-z0-9]{1,32}$/);
    assert.match(idB, /^[A-Za-z0-9]{1,32}$/);
    assert.notEqual(idA, idB, 'Different tenants must produce non-colliding clOrdIds');
  });

  it('simulates zero-key capital preview sizing for Micro vs Whale equities & real local candles', async () => {
    const { dir, config } = makeTempConfig();
    tmpDirs.push(dir);
    const store = new StandaloneStore({ dbPath: path.join(dir, 'comm.sqlite'), allowedBaseDir: dir });
    const engine = new CommercialPlatformEngine({ store, config });

    const microBin = await engine.simulateCapitalPreview({
      equityUsdt: 40,
      exchange: 'BINANCE',
      symbols: ['BTCUSDT.P', 'SOLUSDT.P'],
      overlayOverrides: {
        'BTCUSDT.P': makeFakeOverlay(1, 95000),
        'SOLUSDT.P': makeFakeOverlay(1, 180),
      },
    });
    assert.equal(microBin.bracket.bracket, 'MICRO');
    assert.equal(microBin.rows.find(r => r.symbol === 'BTCUSDT.P').feasible, false);
    assert.equal(microBin.rows.find(r => r.symbol === 'SOLUSDT.P').feasible, true);

    const microOkx = await engine.simulateCapitalPreview({
      equityUsdt: 15,
      exchange: 'OKX',
      symbols: ['BTCUSDT.P', 'SOLUSDT.P'],
      overlayOverrides: {
        'BTCUSDT.P': makeFakeOverlay(1, 95000),
        'SOLUSDT.P': makeFakeOverlay(1, 180),
      },
    });
    assert.equal(microOkx.bracket.bracket, 'MICRO');
    assert.equal(microOkx.rows.find(r => r.symbol === 'BTCUSDT.P').feasible, false);
    assert.equal(microOkx.rows.find(r => r.symbol === 'SOLUSDT.P').feasible, true);

    const whale = await engine.simulateCapitalPreview({
      equityUsdt: 10000,
      exchange: 'OKX',
      symbols: ['BTCUSDT.P', 'SOLUSDT.P'],
      overlayOverrides: {
        'BTCUSDT.P': makeFakeOverlay(1, 95000),
        'SOLUSDT.P': makeFakeOverlay(1, 180),
      },
    });
    assert.equal(whale.bracket.bracket, 'PRO_WHALE');
    assert.equal(whale.rows.find(r => r.symbol === 'BTCUSDT.P').feasible, true);
    assert.ok(whale.rows.find(r => r.symbol === 'BTCUSDT.P').notionalUsdt > 0);

    // Real local 5Y closed candle preview across all 4 crypto assets (v9 + Regime Radar)
    const realPreview = await engine.simulateCapitalPreview({
      equityUsdt: 1500,
      exchange: 'OKX',
      version: 'v9',
      riskTier: 'SAFE_75WR',
    });
    assert.equal(realPreview.ready, true);
    assert.equal(realPreview.bracket.bracket, 'STANDARD');
    assert.equal(realPreview.rows.length, 4);
    for (const r of realPreview.rows) {
      assert.ok(r.status === 'ACTIVE_SIGNAL' || r.status === 'REGIME_READY_PREVIEW');
      assert.ok(Number.isFinite(r.entryPx) && r.entryPx > 0);
    }
  });

  it('rejects API keys with WITHDRAW permission during onboarding and stores zero plaintext secrets in SQLite', async () => {
    const { dir, config } = makeTempConfig();
    tmpDirs.push(dir);
    const store = new StandaloneStore({ dbPath: path.join(dir, 'comm.sqlite'), allowedBaseDir: dir });
    const engine = new CommercialPlatformEngine({ store, config });

    const { licenseKey } = issueLicenseKey({
      planId: 'PRO_AUTO_TRADER',
      subscriberRef: 'alice@example.com',
      durationDays: 30,
      signingSecret: TEST_LICENSE_SECRET,
    });

    await assert.rejects(
      () => engine.onboardSubscriber({
        name: 'Alice Withdraw',
        licenseKey,
        exchange: 'OKX',
        apiKey: 'okx_bad_key_1234',
        apiSecret: 'super_secret_withdraw_xyz',
        passphrase: 'pass_withdraw',
        rawPermissionPayload: { perm: 'read_only,trade,withdraw' },
        armingPin: '4321',
        executionMode: 'DEMO_AUTO_TRADE',
      }),
      /WITHDRAW/i,
    );

    const ob = await engine.onboardSubscriber({
      name: 'Alice Safe',
      email: 'alice@example.com',
      licenseKey,
      exchange: 'OKX',
      simulated: true,
      apiKey: 'okx_live_public_99887766',
      apiSecret: 'secret_never_stored_plain_123',
      passphrase: 'pass_never_stored_plain',
      rawPermissionPayload: { perm: 'read_only,trade' },
      armingPin: '8642',
      executionMode: 'DEMO_AUTO_TRADE',
      simulatedEquityUsdt: 1500,
      overlayOverrides: {
        'BTCUSDT.P': makeFakeOverlay(1, 90000),
        'ETHUSDT.P': makeFakeOverlay(1, 3000),
        'SOLUSDT.P': makeFakeOverlay(1, 150),
        'BNBUSDT.P': makeFakeOverlay(1, 600),
      },
    });

    assert.ok(ob.sessionToken.startsWith('sub_tok_'));
    assert.equal(ob.keyMask, 'okx_****7766');

    const rawDump = JSON.stringify(engine.cStore.db.prepare('SELECT * FROM commercial_subscribers').all())
      + JSON.stringify(engine.cStore.db.prepare('SELECT * FROM subscriber_credentials_enc').all());
    assert.equal(rawDump.includes('secret_never_stored_plain_123'), false);
    assert.equal(rawDump.includes('pass_never_stored_plain'), false);
    assert.equal(rawDump.includes('8642'), false);
    assert.equal(rawDump.includes(ob.sessionToken), false);

    const authed = engine.authenticateSubscriber({ sessionToken: ob.sessionToken });
    assert.equal(authed.subscriberId, ob.subscriber.subscriberId);
    assert.throws(() => engine.authenticateSubscriber({ sessionToken: 'wrong_tok' }), /Unauthorized/);
  });

  it('enforces all 7 Commercial Guardrails, routes idempotent orders once, and persists crash recovery', async () => {
    const { dir, config } = makeTempConfig();
    tmpDirs.push(dir);
    const store = new StandaloneStore({ dbPath: path.join(dir, 'comm.sqlite'), allowedBaseDir: dir });
    const engine = new CommercialPlatformEngine({ store, config });

    const { licenseKey: starterKey } = issueLicenseKey({
      planId: 'STARTER_SCAN_SIGNAL',
      subscriberRef: 'starter@example.com',
      signingSecret: TEST_LICENSE_SECRET,
    });
    await assert.rejects(
      () => engine.onboardSubscriber({
        name: 'Starter LiveAttempt',
        licenseKey: starterKey,
        executionMode: 'LIVE_AUTO_TRADE',
        armingPin: '1234',
      }),
      /does not permit/,
    );

    const { licenseKey: proKey } = issueLicenseKey({
      planId: 'PRO_AUTO_TRADER',
      subscriberRef: 'bob@example.com',
      signingSecret: TEST_LICENSE_SECRET,
    });

    let entryCalls = 0;
    let slCalls = 0;
    let lastSlParams = null;
    let cancelCalls = 0;
    const mockClient = {
      async getAccountHealth() {
        return { simulated: true, totalEqUsdt: 2000, availEqUsdt: 1800, openPositions: [] };
      },
      async placePostOnlyEntry() {
        entryCalls++;
        return { dryRun: false, data: [{ ordId: `OKX_E_${entryCalls}` }] };
      },
      async placeReduceOnlySlTp(params) {
        slCalls++;
        lastSlParams = params;
        return { dryRun: false, data: [{ algoId: `OKX_A_${slCalls}` }] };
      },
      async cancelOrder() {
        cancelCalls++;
        return { dryRun: false, data: [{ sCode: '0' }] };
      },
    };

    const ob = await engine.onboardSubscriber({
      name: 'Bob Pro',
      licenseKey: proKey,
      exchange: 'OKX',
      simulated: true,
      apiKey: 'okx_demo_key_1122',
      apiSecret: 'okx_demo_sec_3344',
      passphrase: 'okx_demo_pass',
      rawPermissionPayload: { perm: 'read_only,trade' },
      armingPin: '2468',
      executionMode: 'DEMO_AUTO_TRADE',
      maxDailyLossPct: 5.0,
      maxDdKillPct: 15.0,
      clientOverride: mockClient,
    });
    const subId = ob.subscriber.subscriberId;

    // Wrong PIN blocked by Guardrail 3
    const badPin = await engine.runSubscriberAutoTradeCycle(subId, {
      armingPin: '0000',
      clientOverride: mockClient,
      overlayOverrides: { 'BTCUSDT.P': makeFakeOverlay(1, 90000) },
    });
    assert.equal(badPin.blockedReason, 'GUARDRAIL_3_INVALID_ARMING_PIN');
    assert.equal(entryCalls, 0);

    // Valid PIN executes idempotent entry + SL/TP once
    const run1 = await engine.runSubscriberAutoTradeCycle(subId, {
      armingPin: '2468',
      clientOverride: mockClient,
      overlayOverrides: {
        'BTCUSDT.P': makeFakeOverlay(1, 90000),
        'ETHUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 3000 },
        'SOLUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 150 },
        'BNBUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 600 },
      },
    });
    assert.equal(run1.executed, true);
    assert.equal(entryCalls, 1);
    assert.equal(slCalls, 1);
    assert.equal(lastSlParams?.entrySide, 1);
    const slLog = run1.orders.find(o => o.order_type === 'oco_reduce_only');
    assert.equal(slLog?.payload?.side, 'sell');

    // Repeated cycle on exact same bar skips duplicate order submission
    const run2 = await engine.runSubscriberAutoTradeCycle(subId, {
      armingPin: '2468',
      clientOverride: mockClient,
      overlayOverrides: {
        'BTCUSDT.P': makeFakeOverlay(1, 90000),
        'ETHUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 3000 },
        'SOLUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 150 },
        'BNBUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 600 },
      },
    });
    assert.equal(entryCalls, 1);
    assert.ok(run2.actions.some(a => a.action === 'IDEMPOTENT_SKIP'));

    // Signal expires to FLAT -> cancels stale post-only entry order
    const cancelRes = await engine.runSubscriberAutoTradeCycle(subId, {
      armingPin: '2468',
      clientOverride: mockClient,
      overlayOverrides: {
        'BTCUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 90000 },
        'ETHUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 3000 },
        'SOLUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 150 },
        'BNBUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 600 },
      },
    });
    assert.equal(cancelCalls, 1);
    assert.ok(cancelRes.actions.some(a => a.action === 'CANCELLED_STALE'));

    // Daily Loss 6% (>= 5%) from $2000 day_start_equity trips Guardrail 4 Circuit Breaker
    const cbRes = await engine.runSubscriberAutoTradeCycle(subId, {
      armingPin: '2468',
      simulatedEquityUsdt: 1880,
      overlayOverrides: { 'BTCUSDT.P': makeFakeOverlay(1, 91000) },
    });
    assert.equal(cbRes.blockedReason, 'GUARDRAIL_4_CIRCUIT_BREAKER_TRIPPED');

    // Reset CB cleanly at $2000 high-water, then simulate -17.5% DD ($1650 < $2000 with lower daily loss test? No: raise maxDailyLossPct=25 so Guardrail 5 triggers independently!)
    engine.updateSubscriberMode(subId, { executionMode: 'DEMO_AUTO_TRADE', armingPin: '2468', maxDailyLossPct: 25.0, resetTrips: true });
    await engine.scanSubscriberAccount(subId, {
      simulatedEquityUsdt: 2000,
      overlayOverrides: { 'BTCUSDT.P': makeFakeOverlay(1, 91000) },
    });
    const killRes = await engine.runSubscriberAutoTradeCycle(subId, {
      armingPin: '2468',
      simulatedEquityUsdt: 1650,
      overlayOverrides: { 'BTCUSDT.P': makeFakeOverlay(1, 91000) },
    });
    assert.equal(killRes.blockedReason, 'GUARDRAIL_5_KILL_SWITCH_TRIPPED');
    assert.equal(engine.cStore.getRiskState(subId).killSwitchTripped, true);

    // Reset trips and test Guardrail 6: Equity exceeds PRO plan max ($25k)
    engine.updateSubscriberMode(subId, { executionMode: 'DEMO_AUTO_TRADE', armingPin: '2468', maxDailyLossPct: 5.0, resetTrips: true });
    const capBlocked = await engine.runSubscriberAutoTradeCycle(subId, {
      armingPin: '2468',
      simulatedEquityUsdt: 30000,
      overlayOverrides: { 'BTCUSDT.P': makeFakeOverlay(1, 91000) },
    });
    assert.match(capBlocked.blockedReason, /GUARDRAIL_6_EQUITY_EXCEEDS_PLAN_MAX/);

    // Crash recovery test: SUBMITTING -> INTERRUPTED
    engine.cStore.upsertSubscriberOrderLog({
      clientOrderId: 't10crashtest00000000000000001',
      subscriberId: subId,
      exchange: 'OKX',
      symbol: 'BTCUSDT.P',
      mode: 'DEMO_AUTO_TRADE',
      orderType: 'post_only',
      side: 'buy',
      price: 90000,
      qty: '0.01',
      status: 'SUBMITTING',
    });
    const recovered = engine.cStore.recoverInterruptedSubscriberOrders();
    assert.equal(recovered, 1);
    assert.equal(engine.cStore.findSubscriberOrder('t10crashtest00000000000000001').status, 'INTERRUPTED');

    const admin = engine.getAdminOverview();
    assert.equal(admin.totalSubscribers, 1);
    assert.equal(admin.byPlan.PRO_AUTO_TRADER, 1);
  });

  it('requires >= 32-char COMMERCIAL_MASTER_KEY for LIVE_AUTO_TRADE', async () => {
    const { dir, config } = makeTempConfig({ commercialMasterKey: 'short_key_16chars' });
    tmpDirs.push(dir);
    const store = new StandaloneStore({ dbPath: path.join(dir, 'comm.sqlite'), allowedBaseDir: dir });
    const engine = new CommercialPlatformEngine({ store, config });
    const { licenseKey } = issueLicenseKey({
      planId: 'INSTITUTIONAL_VIP',
      subscriberRef: 'vip@example.com',
      signingSecret: TEST_LICENSE_SECRET,
    });

    await assert.rejects(
      () => engine.onboardSubscriber({
        name: 'VIP ShortMaster',
        licenseKey,
        executionMode: 'LIVE_AUTO_TRADE',
        armingPin: '9999',
        apiKey: 'okx_vip_1234',
        apiSecret: 'okx_vip_sec',
        rawPermissionPayload: { perm: 'read_only,trade' },
      }),
      /COMMERCIAL_MASTER_KEY/,
    );
  });
});
