import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { after, describe, it } from 'node:test';
import { loadConfig, redactConfig } from './config.mjs';
import { StandaloneStore } from './store_sqlite.mjs';
import { CommercialStore } from './commercial_store.mjs';
import { CommercialPlatformEngine } from './commercial_engine.mjs';
import { AutopilotScheduler } from './autopilot-scheduler.mjs';
import { loadRuntimeSpecs } from './engine_runtime.mjs';
import { createStandaloneServer } from './server.mjs';
import { issueLicenseKey } from './license_issuer.mjs';
import { ensureLocalServeSecrets } from './cli.mjs';
import { decryptCredentials } from './crypto_vault.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TEST_MASTER_KEY = 'TestMasterKey32CharsMin_v11Autopilot!';
const TEST_LICENSE_SECRET = 'TestLicenseSecret_v11_HMAC_Signing!';

function makeFakeOverlay(side = 1, px = 90000, barTime = 1766000000) {
  return {
    summary: { modelVersion: 'v9.0-WalkForwardEnsemble' },
    regime: {
      regime: side === 1 ? 'BULL_TREND' : 'BEAR_TREND',
      trendScore: 0.7 * side,
      longPriority: side === 1 ? 1 : 0,
      shortPriority: side === -1 ? 1 : 0,
    },
    execOptions: { stopAtr: 3.2, minStopPct: 1.4, rewardRisk: 1.25, minLev: 1.5 },
    lastClose: px,
    latestBarTime: barTime,
    activeOverlay: {
      status: 'PENDING_LIMIT',
      side,
      signalTime: barTime,
      limitPrice: px,
      stop: px - side * (px * 0.02),
      target: px + side * (px * 0.025),
      lev: 1.5,
      probWin: 0.78,
    },
  };
}

describe('v11.0 Continuous Background Autopilot Backend', () => {
  const tmpDirs = [];
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('loads v11 config defaults & clamps AUTOPILOT_INTERVAL_SEC while keeping PAPER/DRY_RUN intact', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v11-cfg-'));
    tmpDirs.push(tmp);

    const defCfg = loadConfig({ cwd: REPO_ROOT, useProcessEnv: false });
    assert.equal(defCfg.executionMode, 'PAPER');
    assert.equal(defCfg.dryRun, true);
    assert.equal(defCfg.localQuickstartEnabled, true);
    assert.equal(defCfg.autopilotIntervalSec, 60);
    assert.equal(redactConfig(defCfg).localQuickstartEnabled, true);
    assert.equal(redactConfig(defCfg).autopilotIntervalSec, 60);

    const lowCfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: { LOCAL_QUICKSTART_ENABLED: 'false', AUTOPILOT_INTERVAL_SEC: '1' },
    });
    assert.equal(lowCfg.localQuickstartEnabled, false);
    assert.equal(lowCfg.autopilotIntervalSec, 5);

    const highCfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: { AUTOPILOT_INTERVAL_SEC: '99999' },
    });
    assert.equal(highCfg.autopilotIntervalSec, 3600);
  });

  it('supports 1-click connect-and-start, multi-tick idempotency, auto-disarm on CB trip, manual pause cancelling pending entries while preserving reduceOnly SL/TP, and zero plaintext secrets', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v11-sched-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'v11_autopilot.sqlite');

    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        LOCAL_QUICKSTART_ENABLED: 'true',
        AUTOPILOT_INTERVAL_SEC: '5',
        COMMERCIAL_MASTER_KEY: TEST_MASTER_KEY,
        COMMERCIAL_LICENSE_SECRET: TEST_LICENSE_SECRET,
      },
    });
    const store = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const cStore = new CommercialStore(store);

    let equity = 2000;
    let entryCalls = 0;
    let slTpCalls = 0;
    const cancelledClIds = [];
    const mockClient = {
      async getAccountHealth() {
        return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: equity, availEqUsdt: equity, openPositions: [] };
      },
      async placePostOnlyEntry() {
        entryCalls += 1;
        return { dryRun: false, exchange: 'OKX', data: [{ ordId: `ord_${entryCalls}`, sCode: '0' }] };
      },
      async placeReduceOnlySlTp() {
        slTpCalls += 1;
        return { dryRun: false, exchange: 'OKX', data: [{ algoId: `algo_${slTpCalls}`, sCode: '0' }] };
      },
      async cancelOrder(params) {
        cancelledClIds.push(params.clOrdId || params.origClientOrderId);
        return { dryRun: false, exchange: 'OKX', data: [{ sCode: '0' }] };
      },
    };

    let syncCalls = 0;
    const mockDaemon = {
      async syncMarketData() {
        syncCalls += 1;
        throw new Error('simulated transient network error');
      },
    };

    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const engine = new CommercialPlatformEngine({
      store,
      commercialStore: cStore,
      config: cfg,
      runtimeSpecs,
      exchangeClientFactory: () => mockClient,
    });
    const scheduler = new AutopilotScheduler({
      config: cfg,
      store,
      commercialStore: cStore,
      commercialEngine: engine,
      daemon: mockDaemon,
    });

    const apiSecret = 'v11_super_secret_never_on_disk_999';
    const passphrase = 'v11_passphrase_never_on_disk_888';
    const armingPin = '4826';
    const { licenseKey } = issueLicenseKey({
      planId: 'PRO_AUTO_TRADER',
      subscriberRef: 'v11@local',
      durationDays: 30,
      signingSecret: TEST_LICENSE_SECRET,
    });

    const ob = await engine.onboardSubscriber({
      name: 'V11 Trader',
      licenseKey,
      exchange: 'OKX',
      simulated: true,
      apiKey: 'okx_v11_pub_55667788',
      apiSecret,
      passphrase,
      rawPermissionPayload: { perm: 'read_only,trade' },
      armingPin,
      executionMode: 'DEMO_AUTO_TRADE',
      maxDailyLossPct: 5.0,
      maxDdKillPct: 20.0,
      clientOverride: mockClient,
      overlayOverrides: { 'BTCUSDT.P': makeFakeOverlay(1, 90000, 1766000000) },
    });
    const subId = ob.subscriber.subscriberId;

    const overlayTick1 = {
      'BTCUSDT.P': makeFakeOverlay(1, 90000, 1766003600),
      'ETHUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 3000 },
      'SOLUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 150 },
      'BNBUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 600 },
    };

    // Arm subscriber -> immediate tick places entry + SL/TP once, PIN stays only in private #leases
    const armRes = await scheduler.armSubscriber({
      subscriberId: subId,
      armingPin,
      intervalSec: 5,
      clientOverride: mockClient,
      overlayOverrides: overlayTick1,
    });
    assert.equal(armRes.armed, true);
    assert.equal(armRes.session.state, 'ARMED_RUNNING');
    assert.equal(armRes.session.cycle_count, 1);
    assert.ok(syncCalls >= 1, 'daemon.syncMarketData should be invoked non-fatally');
    assert.equal(entryCalls, 1);
    assert.equal(slTpCalls, 1);
    assert.equal(JSON.stringify(scheduler).includes(armingPin), false, 'Private #leases must never serialize');
    assert.equal(util.inspect(scheduler, { depth: 5 }).includes(armingPin), false, 'Private #leases must never inspect');

    // Second tick on same bar -> idempotent skip (zero duplicate orders)
    const tick2 = await scheduler.tickSubscriber(subId, { overlayOverrides: overlayTick1 });
    assert.equal(tick2.ticked, true);
    assert.equal(tick2.session.cycle_count, 2);
    assert.equal(entryCalls, 1);
    assert.ok(tick2.actions.some(a => a.action === 'IDEMPOTENT_SKIP'));

    // Guardrail checklist shows all 7 G1..G7 passing while armed
    const checklistArmed = engine.buildGuardrailChecklist(subId, { isAutopilotArmed: true });
    assert.equal(checklistArmed.length, 7);
    assert.ok(checklistArmed.every(g => g.ok === true));

    // Multi-tick background timer execution: set next_tick_at in the past and let setInterval fire automatically
    cStore.upsertAutopilotSession({ subscriberId: subId, nextTickAt: Date.now() - 10 });
    scheduler.start(50);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && cStore.getAutopilotSession(subId).cycle_count < 3) {
      await new Promise(r => setTimeout(r, 40));
    }
    scheduler.stop();
    assert.ok(cStore.getAutopilotSession(subId).cycle_count >= 3, 'Background timer should execute due ticks');
    assert.equal(entryCalls, 1, 'Background ticks must remain idempotent');

    // Manual pause with cancelPendingEntries cancels non-reduceOnly SUBMITTED entry while preserving reduceOnly SL/TP
    const disarmRes = await scheduler.disarmSubscriber(subId, {
      reason: 'MANUAL_PAUSE',
      cancelPendingEntries: true,
      clientOverride: mockClient,
    });
    assert.equal(disarmRes.disarmed, true);
    assert.equal(disarmRes.session.state, 'DISARMED');
    assert.equal(disarmRes.cancelledOrders.length, 1);
    assert.equal(cancelledClIds.length, 1);

    const ordersAfterPause = cStore.getSubscriberOrdersLog({ subscriberId: subId, limit: 20 });
    const entryOrder = ordersAfterPause.find(o => !o.reduceOnly && o.order_type === 'post_only');
    const slOrder = ordersAfterPause.find(o => o.reduceOnly && o.order_type === 'oco_reduce_only');
    assert.equal(entryOrder.status, 'CANCELLED');
    assert.equal(slOrder.status, 'SUBMITTED', 'reduceOnly SL/TP protection leg must be preserved');

    // Re-arm and verify auto-disarm on Daily Loss Circuit Breaker trip (6% drop >= 5%)
    await scheduler.armSubscriber({
      subscriberId: subId,
      armingPin,
      intervalSec: 5,
      clientOverride: mockClient,
      overlayOverrides: overlayTick1,
      runImmediately: false,
    });
    equity = 1880;
    const cbTick = await scheduler.tickSubscriber(subId, { overlayOverrides: overlayTick1 });
    assert.equal(cbTick.autoDisarmed, true);
    assert.equal(cbTick.blockedReason, 'GUARDRAIL_4_CIRCUIT_BREAKER_TRIPPED');
    assert.equal(cbTick.session.state, 'TRIPPED');
    assert.equal(scheduler.isArmed(subId), false);
    const events = cStore.listAutopilotEvents({ subscriberId: subId, limit: 20 });
    assert.ok(events.some(e => e.event_type === 'GUARDRAIL_TRIP'));

    scheduler.stop();
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    store.close();

    // Verify zero plaintext secrets in raw SQLite bytes
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(p => fs.existsSync(p))) {
      const raw = fs.readFileSync(f, 'utf8');
      for (const secret of [apiSecret, passphrase, armingPin, ob.sessionToken]) {
        assert.equal(raw.includes(secret), false, `Plaintext secret leaked in ${path.basename(f)}`);
      }
    }
  });

  it('handles HTTP v11 E2E connect-and-start, verify-connection 403 block, unlock token rotation, crash recovery REARM_REQUIRED & start auto-upgrade', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v11-http-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'v11_http.sqlite');

    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        LOCAL_QUICKSTART_ENABLED: 'true',
        AUTOPILOT_INTERVAL_SEC: '10',
        COMMERCIAL_MASTER_KEY: TEST_MASTER_KEY,
        COMMERCIAL_LICENSE_SECRET: TEST_LICENSE_SECRET,
      },
    });
    const store = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);

    const buildMockClient = () => ({
      async getAccountHealth() {
        return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 1500, availEqUsdt: 1400, openPositions: [] };
      },
      async placePostOnlyEntry() {
        return { dryRun: false, exchange: 'OKX', data: [{ ordId: 'http_ord_1', sCode: '0' }] };
      },
      async placeReduceOnlySlTp() {
        return { dryRun: false, exchange: 'OKX', data: [{ algoId: 'http_algo_1', sCode: '0' }] };
      },
      async cancelOrder() {
        return { dryRun: false, exchange: 'OKX', data: [{ sCode: '0' }] };
      },
    });

    const srv = createStandaloneServer({
      config: cfg,
      store,
      runtimeSpecs,
      exchangeClientFactory: buildMockClient,
    });

    let subId = '';
    let tok1 = '';
    let tok2 = '';
    const apiSecret = 'http_v11_secret_never_leak_777';
    const passphrase = 'http_v11_pass_never_leak_666';
    const armingPin = '7391';

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      // 1) /api/status reports v11AutopilotReady: true & v10CommercialReady: true
      const statusJson = await (await fetch(`${base}/api/status`)).json();
      assert.equal(statusJson.models.v10CommercialReady, true);
      assert.equal(statusJson.models.v11AutopilotReady, true);

      // 2) verify-connection blocks WITHDRAW with 403 and succeeds on clean key
      const badProbe = await fetch(`${base}/api/autopilot/verify-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_withdraw_1234',
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade,withdraw' },
        }),
      });
      assert.equal(badProbe.status, 403);

      const goodProbeRes = await fetch(`${base}/api/autopilot/verify-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_clean_key_4321',
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade' },
          simulatedEquityUsdt: 1500,
        }),
      });
      assert.equal(goodProbeRes.status, 200);
      const goodProbe = await goodProbeRes.json();
      assert.equal(goodProbe.withdrawBlocked, true);
      assert.equal(goodProbe.bracket.bracket, 'STANDARD');
      assert.ok(Array.isArray(goodProbe.previewRows) && goodProbe.previewRows.length >= 3);

      // 3) 1-click quickstart-license & connect-and-start (without manually passing licenseKey)
      const qlRes = await fetch(`${base}/api/autopilot/quickstart-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberRef: 'quick@local' }),
      });
      assert.equal(qlRes.status, 200);
      assert.ok((await qlRes.json()).licenseKey.startsWith('TT10.'));

      const connectRes = await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Quickstart User',
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_quick_key_8899',
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin,
          autoStart: false,
          simulatedEquityUsdt: 1500,
        }),
      });
      assert.equal(connectRes.status, 200);
      const connectJson = await connectRes.json();
      assert.equal(connectJson.ok, true);
      assert.equal(connectJson.subscriber.executionMode, 'SCAN_AND_SIGNAL_ONLY');
      subId = connectJson.subscriber.subscriberId;
      tok1 = connectJson.sessionToken;

      // 3b) 1-click connect-and-start with default autoStart: true arms immediately in DEMO_AUTO_TRADE
      const oneClickRes = await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'OneClick Armed Trader',
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_oneclick_key_5566',
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin,
          simulatedEquityUsdt: 1500,
        }),
      });
      assert.equal(oneClickRes.status, 200);
      const oneClickJson = await oneClickRes.json();
      assert.equal(oneClickJson.ok, true);
      assert.equal(oneClickJson.subscriber.executionMode, 'DEMO_AUTO_TRADE');
      assert.equal(oneClickJson.autopilot.armed, true);
      assert.equal(oneClickJson.status.session.state, 'ARMED_RUNNING');
      await fetch(`${base}/api/autopilot/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': oneClickJson.sessionToken },
        body: JSON.stringify({ cancelPendingEntries: false }),
      });

      // 4) POST /api/autopilot/start auto-upgrades SCAN_AND_SIGNAL_ONLY -> DEMO_AUTO_TRADE
      const startRes = await fetch(`${base}/api/autopilot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': tok1 },
        body: JSON.stringify({ armingPin, intervalSec: 15, simulatedEquityUsdt: 1500 }),
      });
      assert.equal(startRes.status, 200);
      const startJson = await startRes.json();
      assert.equal(startJson.armed, true);
      assert.equal(startJson.session.execution_mode, 'DEMO_AUTO_TRADE');
      assert.equal(startJson.status.guardrailChecklist.length, 7);

      // 5) POST /api/commercial/subscribers/unlock rejects bad PIN (403), rotates sessionToken on valid PIN
      const badUnlock = await fetch(`${base}/api/commercial/subscribers/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: subId, armingPin: '0000' }),
      });
      assert.equal(badUnlock.status, 403);

      const goodUnlockRes = await fetch(`${base}/api/commercial/subscribers/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: subId, armingPin }),
      });
      assert.equal(goodUnlockRes.status, 200);
      const goodUnlock = await goodUnlockRes.json();
      tok2 = goodUnlock.sessionToken;
      assert.notEqual(tok2, tok1);

      // Old token tok1 must now be rejected (401), new token tok2 succeeds
      const oldStatus = await fetch(`${base}/api/autopilot/status`, {
        headers: { 'x-subscriber-token': tok1 },
      });
      assert.equal(oldStatus.status, 401);

      const newStatus = await fetch(`${base}/api/autopilot/status`, {
        headers: { 'x-subscriber-token': tok2 },
      });
      assert.equal(newStatus.status, 200);
      const newStatusJson = await newStatus.json();
      assert.equal(newStatusJson.armed, true);
      assert.ok(newStatusJson.savedProfiles.length >= 1);

      // Ensure no plaintext secrets in HTTP payloads
      const allBodies = JSON.stringify({ goodProbe, connectJson, startJson, goodUnlock, newStatusJson });
      for (const secret of [apiSecret, passphrase, armingPin]) {
        assert.equal(allBodies.includes(secret), false);
      }

      // 6) LOCAL_QUICKSTART_ENABLED=false blocks quickstart-license with 403
      cfg.localQuickstartEnabled = false;
      const blockedQl = await fetch(`${base}/api/autopilot/quickstart-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(blockedQl.status, 403);
    } finally {
      await srv.stop();
    }

    // 7) Crash recovery simulation: reopen server without disarming -> ARMED_RUNNING transitions to REARM_REQUIRED
    const srv2 = createStandaloneServer({
      config: cfg,
      store,
      runtimeSpecs,
      exchangeClientFactory: buildMockClient,
    });
    try {
      const bound2 = await srv2.start();
      const base2 = `http://${bound2.host}:${bound2.port}`;
      const recoveredRes = await fetch(`${base2}/api/autopilot/status`, {
        headers: { 'x-subscriber-token': tok2 },
      });
      assert.equal(recoveredRes.status, 200);
      const recoveredJson = await recoveredRes.json();
      assert.equal(recoveredJson.armed, false);
      assert.equal(recoveredJson.session.state, 'REARM_REQUIRED');
      assert.equal(recoveredJson.session.disarm_reason, 'SERVER_RESTART_PIN_REARM_REQUIRED');

      // Stop endpoint works cleanly with valid token
      const stopRes = await fetch(`${base2}/api/autopilot/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': tok2 },
        body: JSON.stringify({ cancelPendingEntries: false }),
      });
      assert.equal(stopRes.status, 200);
      assert.equal((await stopRes.json()).session.state, 'DISARMED');
    } finally {
      await srv2.stop();
      store.close();
    }
  });

  it('supports v12 1-click zero-key Paper Sandbox, in-place upgrade without duplicates, settings update preserving keys, delete-profile cascade, and friendly errors', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v12-e2e-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'v12.sqlite');

    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        LOCAL_QUICKSTART_ENABLED: 'true',
        AUTOPILOT_INTERVAL_SEC: '15',
        COMMERCIAL_MASTER_KEY: TEST_MASTER_KEY,
        COMMERCIAL_LICENSE_SECRET: TEST_LICENSE_SECRET,
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
          return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 2500, availEqUsdt: 2300, openPositions: [] };
        },
        async placePostOnlyEntry() {
          return { dryRun: true, exchange: 'OKX', data: [{ ordId: 'v12_ord_1' }] };
        },
        async placeReduceOnlySlTp() {
          return { dryRun: true, exchange: 'OKX', data: [{ algoId: 'v12_algo_1' }] };
        },
        async cancelOrder() {
          return { dryRun: true, exchange: 'OKX', data: [{ sCode: '0' }] };
        },
      }),
    });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      // 1) 1-click Zero-Key Paper Sandbox creation + reuse (no duplicate sandbox)
      const sb1Res = await fetch(`${base}/api/autopilot/demo-sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: 'OKX' }),
      });
      assert.equal(sb1Res.status, 200);
      const sb1 = await sb1Res.json();
      assert.equal(sb1.ok, true);
      assert.equal(sb1.subscriber.email, 'paper-sandbox@local');
      assert.equal(sb1.subscriber.executionMode, 'PAPER_AUTO_TRADE');
      assert.equal(sb1.subscriber.isPaperSandbox, true);
      assert.equal(sb1.autopilot.armed, true);
      assert.equal(sb1.status.portfolioSummary.totalEquityUsdt, 1000);
      assert.ok(Array.isArray(sb1.status.scanHistory) && sb1.status.scanHistory.length >= 1);
      assert.ok(Array.isArray(sb1.status.activePositions));
      assert.ok(Array.isArray(sb1.status.portfolioSummary.equitySparkline));
      assert.ok(sb1.status.guardrailChecklist.every(g => g.ok === true));

      const sb2Res = await fetch(`${base}/api/autopilot/demo-sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: 'BINANCE' }),
      });
      assert.equal(sb2Res.status, 200);
      const sb2 = await sb2Res.json();
      assert.equal(sb2.subscriber.subscriberId, sb1.subscriber.subscriberId, 'Sandbox must reuse single persistent profile');
      assert.equal(sb2.subscriber.exchange, 'BINANCE');
      assert.equal(sb2.status.savedProfiles.length, 1);

      // 2) In-place upgrade via connect-and-start (no orphan duplicate profiles)
      const upgRes = await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': sb2.sessionToken },
        body: JSON.stringify({
          subscriberId: sb2.subscriber.subscriberId,
          name: 'Upgraded Demo Account',
          email: 'paper-sandbox@local',
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_upg_key_1122',
          apiSecret: 'okx_upg_secret_never_leak',
          passphrase: 'okx_upg_pass_never_leak',
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin: '5150',
          simulatedEquityUsdt: 2500,
        }),
      });
      assert.equal(upgRes.status, 200);
      const upg = await upgRes.json();
      assert.equal(upg.subscriber.subscriberId, sb1.subscriber.subscriberId);
      assert.equal(upg.subscriber.executionMode, 'DEMO_AUTO_TRADE');
      assert.equal(upg.subscriber.keyMask, 'okx_****1122');
      assert.equal(upg.status.savedProfiles.length, 1, 'In-place upgrade must not spawn duplicate profiles');

      // 3) POST /api/autopilot/settings updates metadata/risk without wiping encrypted credentials when blank
      const setRes = await fetch(`${base}/api/autopilot/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': upg.sessionToken },
        body: JSON.stringify({
          name: 'Renamed Demo Pro',
          riskTier: 'BALANCED_75WR',
          intervalSec: 30,
          apiKey: '',
          apiSecret: '',
          passphrase: '',
        }),
      });
      assert.equal(setRes.status, 200);
      const setJson = await setRes.json();
      assert.equal(setJson.subscriber.name, 'Renamed Demo Pro');
      assert.equal(setJson.subscriber.riskTier, 'BALANCED_75WR');
      assert.equal(setJson.subscriber.hasCredentials, true);
      assert.equal(setJson.subscriber.keyMask, 'okx_****1122');
      assert.equal(setJson.status.session.interval_sec, 30);

      // Verify encrypted credentials in DB still decrypt cleanly
      const credRow = srv.autopilotScheduler.cStore.getEncryptedCredentials(upg.subscriber.subscriberId);
      const dec = decryptCredentials(credRow.envelope, TEST_MASTER_KEY, `${upg.subscriber.subscriberId}|OKX`);
      assert.equal(dec.apiSecret, 'okx_upg_secret_never_leak');

      // 4) Friendly error envelope on 403 WITHDRAW block
      const withdrawRes = await fetch(`${base}/api/autopilot/verify-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: 'OKX',
          apiKey: 'okx_bad_1234',
          apiSecret: 'sec_bad',
          passphrase: 'pass',
          rawPermissionPayload: { perm: 'read_only,trade,withdraw' },
        }),
      });
      assert.equal(withdrawRes.status, 403);
      const withdrawJson = await withdrawRes.json();
      assert.equal(withdrawJson.ok, false);
      assert.match(withdrawJson.error, /WITHDRAW/i);
      assert.ok(typeof withdrawJson.userMessage === 'string' && withdrawJson.userMessage.length > 0);
      assert.ok(typeof withdrawJson.recoveryHint === 'string' && withdrawJson.recoveryHint.length > 0);

      // 5) POST /api/autopilot/delete-profile disarms & cascade-deletes subscriber
      const delRes = await fetch(`${base}/api/autopilot/delete-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': upg.sessionToken },
        body: JSON.stringify({ subscriberId: upg.subscriber.subscriberId }),
      });
      assert.equal(delRes.status, 200);
      const delJson = await delRes.json();
      assert.equal(delJson.deleted, true);
      assert.equal(delJson.status.savedProfiles.length, 0);
      assert.equal(delJson.status.armedCount, 0);
    } finally {
      await srv.stop();
      store.close();
    }
  });

  it('persists local keystore (.local-vault.secret chmod 0600) across restarts via ensureLocalServeSecrets without altering loadConfig() defaults', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v12-keystore-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'keystore.sqlite');
    const secretFile = path.join(tmp, '.local-vault.secret');

    // Invariant: loadConfig() with no .env keeps masterKeyConfigured === false
    const cleanCfg = loadConfig({ cwd: tmp, useProcessEnv: false });
    assert.equal(redactConfig(cleanCfg).commercial.masterKeyConfigured, false);

    // Boot 1: generate .local-vault.secret and onboard encrypted profile
    const cfg1 = loadConfig({ cwd: tmp, useProcessEnv: false });
    const ks1 = ensureLocalServeSecrets(cfg1, { secretPath: secretFile });
    assert.equal(ks1.generated, true);
    assert.ok(cfg1.commercialMasterKey.length >= 32);
    assert.ok(cfg1.commercialLicenseSecret.length >= 32);
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);

    const store1 = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv1 = createStandaloneServer({
      config: cfg1,
      store: store1,
      runtimeSpecs,
      exchangeClientFactory: () => ({
        async getAccountHealth() {
          return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 1200, availEqUsdt: 1100, openPositions: [] };
        },
      }),
    });

    let subId = '';
    try {
      const b1 = await srv1.start();
      const res = await fetch(`http://${b1.host}:${b1.port}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Keystore Persist User',
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_ks_key_7788',
          apiSecret: 'ks_secret_across_restart',
          passphrase: 'ks_pass_across_restart',
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin: '2468',
          autoStart: false,
          simulatedEquityUsdt: 1200,
        }),
      });
      assert.equal(res.status, 200);
      subId = (await res.json()).subscriber.subscriberId;
    } finally {
      await srv1.stop();
      store1.close();
    }

    // Boot 2: fresh config reloads exact same .local-vault.secret and decrypts stored credentials cleanly
    const cfg2 = loadConfig({ cwd: tmp, useProcessEnv: false });
    assert.equal(redactConfig(cfg2).commercial.masterKeyConfigured, false);
    const ks2 = ensureLocalServeSecrets(cfg2, { secretPath: secretFile });
    assert.equal(ks2.generated, false);
    assert.equal(ks2.loaded, true);
    assert.equal(cfg2.commercialMasterKey, cfg1.commercialMasterKey);

    const store2 = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const srv2 = createStandaloneServer({ config: cfg2, store: store2, runtimeSpecs });
    try {
      const credRow = srv2.autopilotScheduler.cStore.getEncryptedCredentials(subId);
      const dec = decryptCredentials(credRow.envelope, cfg2.commercialMasterKey, `${subId}|OKX`);
      assert.equal(dec.apiSecret, 'ks_secret_across_restart');
      assert.equal(dec.passphrase, 'ks_pass_across_restart');
    } finally {
      await srv2.stop();
      store2.close();
    }
  });
});
