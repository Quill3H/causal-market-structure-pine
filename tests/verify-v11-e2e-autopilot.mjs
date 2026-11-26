import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../standalone/config.mjs';
import { StandaloneStore } from '../standalone/store_sqlite.mjs';
import { loadRuntimeSpecs } from '../standalone/engine_runtime.mjs';
import { createStandaloneServer } from '../standalone/server.mjs';
import { OkxClient } from '../standalone/exchange_okx.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'standalone', 'public');
const ALPHANUM_CLORDID_RE = /^[A-Za-z0-9]{1,32}$/;

// Complete set of v10 Quant Pro + Commercial Hub DOM IDs that must remain intact in v11.0
const LEGACY_DOM_IDS = [
  'active-levels-list', 'api-badge', 'candle-canvas', 'chart-hover-info', 'chart-title',
  'comm-apikey-input', 'comm-apisecret-input', 'comm-cb-badge', 'comm-email-input', 'comm-ex-select',
  'comm-ks-badge', 'comm-license-input', 'comm-mode-btn', 'comm-mode-select', 'comm-name-input',
  'comm-onboard-btn', 'comm-orders-table', 'comm-orders-tbody', 'comm-passphrase-input', 'comm-pin-input',
  'comm-plans-badge', 'comm-runcycle-btn', 'comm-scan-btn', 'comm-sim-bracket-badge', 'comm-sim-btn',
  'comm-sim-equity', 'comm-sim-exchange', 'comm-sim-meta', 'comm-sim-risk', 'comm-sim-status',
  'comm-sim-table', 'comm-sim-tbody', 'comm-sim-toggle', 'comm-sim-version', 'comm-sub-badge',
  'comm-tickets-table', 'comm-tickets-tbody', 'comm-vault-meta', 'comm-vault-status', 'comm-withdraw-notice',
  'commercial-hub-section', 'commercial-onboard-form', 'commercial-sim-form', 'commercial-sim-panel',
  'commercial-vault-portal', 'confirm-token-input', 'frontier-stats-list', 'frontier-tier-badge',
  'frontier-version-select', 'kpi-comp-net-main', 'kpi-dd', 'kpi-funding', 'kpi-liq-buffer',
  'kpi-liq-sub', 'kpi-model', 'kpi-pf', 'kpi-regime', 'kpi-regime-sub', 'kpi-source',
  'kpi-total-net-sub', 'kpi-trades', 'kpi-wilson', 'kpi-winrate', 'ml-decision-badge',
  'ml-gauge-canvas', 'ml-prob-text', 'ml-threshold-text', 'mode-badge', 'mode-form',
  'mode-select', 'mode-status-msg', 'model-subtitle', 'okx-key-guide-grid', 'order-router-panel',
  'orders-table', 'orders-tbody', 'profile-select', 'radar-action-text', 'radar-breadth-bar',
  'radar-breadth-text', 'radar-coins-row', 'radar-long-mult', 'radar-regime-badge', 'radar-short-mult',
  'radar-stats-list', 'refresh-btn', 'regime-radar-panel', 'router-mode-badge', 'router-reason-text',
  'run-backtest-btn', 'signals-table', 'signals-table-caption', 'signals-tbody', 'sweep-gauge-canvas',
  'sweep-meta-text', 'sweep-mo-text', 'symbol-select', 'tier-select', 'timeframe-select',
  'trades-table', 'trades-table-caption', 'trades-tbody', 'version-select', 'versions-matrix-panel',
  'versions-recs-grid', 'versions-source-text', 'versions-status-badge', 'versions-table', 'versions-tbody',
];

const V11_DOM_IDS = [
  'view-tab-autopilot', 'view-tab-flow', 'view-tab-quant',
  'e2e-autopilot-view', 'e2e-flow-view', 'quant-pro-view',
  'topbar-autopilot-pill', 'topbar-emergency-stop-btn',
  'e2e-status-banner', 'e2e-saved-profiles-card', 'e2e-wizard-panel', 'e2e-cockpit-panel',
  'e2e-ex-select', 'e2e-env-select', 'e2e-verify-btn', 'e2e-connect-start-btn',
  'e2e-guardrails-list', 'e2e-tickets-table', 'e2e-orders-table', 'e2e-events-list',
  'e2e-flow-stages', 'e2e-evolution-table',
];

function makeFakeActiveOverlay({ side = 1, price = 90000, barTime = 1767000000 } = {}) {
  return {
    summary: { modelVersion: 'v9.0-WalkForwardEnsemble' },
    regime: {
      regime: side === 1 ? 'BULL_TREND' : 'BEAR_TREND',
      trendScore: 0.74 * side,
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
      probWin: 0.79,
    },
  };
}

describe('v11.0 E2E Autopilot Independent Verification', () => {
  const tmpDirs = [];
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('1. Static Zero-XSS audit on standalone/public/* and legacy + v11 DOM ID preservation', () => {
    const publicFiles = fs.readdirSync(PUBLIC_DIR);
    assert.ok(publicFiles.includes('index.html'));
    assert.ok(publicFiles.includes('app.js'));
    assert.ok(publicFiles.includes('styles.css'));

    const forbiddenSinks = [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /\bsetHTMLUnsafe\b/,
      /javascript:/i,
    ];

    for (const file of publicFiles) {
      const fullPath = path.join(PUBLIC_DIR, file);
      if (!fs.statSync(fullPath).isFile()) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pat of forbiddenSinks) {
        assert.equal(pat.test(content), false, `Forbidden XSS sink ${pat} found in standalone/public/${file}`);
      }
      assert.equal(content.includes('\u2014'), false, `Em-dash found in standalone/public/${file}`);
    }

    const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    assert.equal(/\son[a-z]+\s*=/i.test(indexHtml), false, 'Inline on* event handler found in index.html');
    const scriptTags = indexHtml.match(/<script\b[^>]*>/gi) || [];
    for (const tag of scriptTags) {
      assert.ok(/\bsrc\s*=/i.test(tag), `Inline <script> without src found in index.html: ${tag}`);
    }

    for (const domId of [...LEGACY_DOM_IDS, ...V11_DOM_IDS]) {
      assert.ok(
        indexHtml.includes(`id="${domId}"`),
        `Required DOM id="${domId}" missing from standalone/public/index.html`,
      );
    }

    const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    assert.ok(appJs.includes('document.createElement'));
    assert.ok(appJs.includes('textContent'));
  });

  it('2. Full E2E HTTP Loopback + Background Autopilot Scheduler + Stop + Restart Recovery + Unlock + Raw SQLite Byte Audit', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v11-e2e-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'v11_e2e.sqlite');

    const masterKey = 'v11-e2e-vault-master-key-32chars-minimum!!';
    const licenseSecret = 'v11-e2e-license-signing-secret-999';
    const apiKey = 'okx_v11_e2e_pub_9911aabb';
    const apiSecret = 'V11_E2E_PLAINTEXT_API_SECRET_NEVER_ON_DISK';
    const passphrase = 'V11_E2E_PLAINTEXT_PASSPHRASE_NEVER_ON_DISK';
    const armingPin = '619428';

    const makeCfg = () => loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        LOCAL_QUICKSTART_ENABLED: 'true',
        AUTOPILOT_INTERVAL_SEC: '5',
        LIVE_CONFIRM_TOKEN: 'tenant_v11_e2e_okx_tok',
        COMMERCIAL_MASTER_KEY: masterKey,
        COMMERCIAL_LICENSE_SECRET: licenseSecret,
      },
    });

    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const okxHttpCalls = [];
    const cancelledClOrdIds = [];

    const buildMockOkx = ({ creds, maxLeverageCap, maxOrderUsdt }) => new OkxClient({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      passphrase: creds.passphrase,
      simulated: true,
      dryRun: false,
      executionMode: 'LIVE_ARMED',
      liveConfirmToken: 'tenant_v11_e2e_okx_tok',
      maxLeverageCap,
      maxOrderUsdt,
      fetchImpl: async (url, init = {}) => {
        const u = String(url);
        const body = init.body ? JSON.parse(init.body) : null;
        if (u.includes('/api/v5/account/balance')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: '0',
              data: [{ totalEq: '2400', details: [{ ccy: 'USDT', availEq: '2200' }] }],
            }),
          };
        }
        if (u.includes('/api/v5/account/positions')) {
          return { ok: true, status: 200, json: async () => ({ code: '0', data: [] }) };
        }
        okxHttpCalls.push({ url: u, headers: init.headers || {}, body });
        if (u.includes('/api/v5/trade/cancel-order') && body?.clOrdId) {
          cancelledClOrdIds.push(body.clOrdId);
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: '0',
            data: [{
              ordId: `v11Ord${okxHttpCalls.length}`,
              algoId: `v11Algo${okxHttpCalls.length}`,
              sCode: '0',
            }],
          }),
        };
      },
    });

    // ---------------- Phase A: Start Server #1 & E2E HTTP Loopback ----------------
    const store1 = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const srv1 = createStandaloneServer({
      config: makeCfg(),
      store: store1,
      runtimeSpecs,
      exchangeClientFactory: ({ creds, maxLeverageCap, maxOrderUsdt }) => buildMockOkx({ creds, maxLeverageCap, maxOrderUsdt }),
    });

    let subId = '';
    let tok1 = '';
    let tok2 = '';

    try {
      const bound = await srv1.start();
      const base = `http://${bound.host}:${bound.port}`;

      // 1) GET /api/autopilot/status initial idle state
      const initialStatus = await (await fetch(`${base}/api/autopilot/status`)).json();
      assert.equal(initialStatus.ok, true);
      assert.equal(initialStatus.running, true);
      assert.equal(initialStatus.armedCount, 0);
      assert.equal(initialStatus.localQuickstartEnabled, true);

      // 2) POST /api/autopilot/verify-connection: 403 block on WITHDRAW, 200 on clean key
      const withdrawProbe = await fetch(`${base}/api/autopilot/verify-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: 'OKX',
          simulated: true,
          apiKey,
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade,withdraw' },
        }),
      });
      assert.equal(withdrawProbe.status, 403);
      const withdrawBody = await withdrawProbe.json();
      assert.equal(withdrawBody.ok, false);
      assert.match(withdrawBody.error, /SECURITY BLOCK|Withdraw/i);
      assert.equal(JSON.stringify(withdrawBody).includes(apiSecret), false);
      assert.equal(JSON.stringify(withdrawBody).includes(passphrase), false);

      const cleanProbeRes = await fetch(`${base}/api/autopilot/verify-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: 'OKX',
          simulated: true,
          apiKey,
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade' },
          simulatedEquityUsdt: 2400,
        }),
      });
      assert.equal(cleanProbeRes.status, 200);
      const cleanProbe = await cleanProbeRes.json();
      assert.equal(cleanProbe.ok, true);
      assert.equal(cleanProbe.withdrawBlocked, true);
      assert.equal(cleanProbe.bracket.bracket, 'PRO_WHALE');
      assert.ok(Array.isArray(cleanProbe.previewRows) && cleanProbe.previewRows.length >= 3);

      // 3) POST /api/autopilot/connect-and-start (autoStart: true)
      const connectRes = await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'E2E Loopback Trader',
          email: 'v11@local',
          exchange: 'OKX',
          simulated: true,
          apiKey,
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin,
          autoStart: true,
          intervalSec: 5,
          simulatedEquityUsdt: 2400,
        }),
      });
      assert.equal(connectRes.status, 200);
      const connectJson = await connectRes.json();
      assert.equal(connectJson.ok, true);
      assert.equal(connectJson.subscriber.executionMode, 'DEMO_AUTO_TRADE');
      assert.equal(connectJson.autopilot.armed, true);
      assert.equal(connectJson.status.session.state, 'ARMED_RUNNING');
      assert.equal(connectJson.status.session.cycle_count, 1);
      assert.equal(connectJson.status.guardrailChecklist.length, 7);
      assert.ok(connectJson.status.guardrailChecklist.every(g => g.ok === true));

      const connectSerialized = JSON.stringify(connectJson);
      assert.equal(connectSerialized.includes(apiSecret), false);
      assert.equal(connectSerialized.includes(passphrase), false);
      assert.equal(connectSerialized.includes(armingPin), false);
      assert.equal(connectSerialized.includes(masterKey), false);

      subId = connectJson.subscriber.subscriberId;
      tok1 = connectJson.sessionToken;

      // 4) Background AutopilotScheduler automatic ticks with deterministic active signal:
      //    Verify SUBMITTED post_only + oco reduceOnly on active signal, and IDEMPOTENT_SKIP on repeat bar.
      const detBarTime = 1767003600;
      const detOverlays = {
        'BTCUSDT.P': makeFakeActiveOverlay({ side: 1, price: 90000, barTime: detBarTime }),
        'ETHUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 3000 },
        'SOLUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 150 },
        'BNBUSDT.P': { summary: { modelVersion: 'v9' }, activeOverlay: { status: 'FLAT' }, lastClose: 600 },
      };

      // Arm with deterministic overlay & runImmediately: false so the background timer itself drives Tick A and Tick B
      const callsBeforeDet = okxHttpCalls.length;
      await srv1.autopilotScheduler.armSubscriber({
        subscriberId: subId,
        armingPin,
        intervalSec: 5,
        overlayOverrides: detOverlays,
        runImmediately: false,
      });
      const cycleBeforeAuto = srv1.autopilotScheduler.cStore.getAutopilotSession(subId).cycle_count;

      // Make session immediately due so srv1's live setInterval(1000ms) triggers Tick A automatically
      srv1.autopilotScheduler.cStore.upsertAutopilotSession({
        subscriberId: subId,
        nextTickAt: Date.now() - 10,
      });
      const deadlineA = Date.now() + 3500;
      while (Date.now() < deadlineA && srv1.autopilotScheduler.cStore.getAutopilotSession(subId).cycle_count < cycleBeforeAuto + 1) {
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(
        srv1.autopilotScheduler.cStore.getAutopilotSession(subId).cycle_count,
        cycleBeforeAuto + 1,
        'Background AutopilotScheduler timer should automatically execute Tick A',
      );

      // Verify single atomic OKX signed trade request (post_only entry with attachAlgoOrds SL/TP)
      assert.equal(okxHttpCalls.length - callsBeforeDet, 1);
      const entryCall = okxHttpCalls[callsBeforeDet];
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

      // Make session due again -> Background timer executes Tick B on same bar -> IDEMPOTENT_SKIP (0 extra orders)
      srv1.autopilotScheduler.cStore.upsertAutopilotSession({
        subscriberId: subId,
        nextTickAt: Date.now() - 10,
      });
      const deadlineB = Date.now() + 3500;
      while (Date.now() < deadlineB && srv1.autopilotScheduler.cStore.getAutopilotSession(subId).cycle_count < cycleBeforeAuto + 2) {
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(
        srv1.autopilotScheduler.cStore.getAutopilotSession(subId).cycle_count,
        cycleBeforeAuto + 2,
        'Background AutopilotScheduler timer should automatically execute Tick B',
      );
      assert.equal(okxHttpCalls.length - callsBeforeDet, 1, 'Repeat bar tick must be IDEMPOTENT_SKIP with zero duplicate orders');

      const statusAfterTicks = await (await fetch(`${base}/api/autopilot/status`, {
        headers: { 'x-subscriber-token': tok1 },
      })).json();
      assert.equal(statusAfterTicks.ok, true);
      assert.equal(statusAfterTicks.armed, true);
      assert.ok(statusAfterTicks.orders.some(o => o.client_order_id === entryCall.body.clOrdId && o.order_type === 'post_only' && o.status === 'SUBMITTED'));
      assert.ok(statusAfterTicks.orders.some(o => o.client_order_id === attachAlgo.attachAlgoClOrdId && o.order_type === 'oco_attached' && o.reduceOnly === true && o.status === 'ATTACHED_TO_ENTRY'));

      // 5) POST /api/autopilot/stop (cancelPendingEntries: true) cancels unfilled entry and attached child log while openPositions is empty
      const stopRes = await fetch(`${base}/api/autopilot/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': tok1 },
        body: JSON.stringify({ cancelPendingEntries: true }),
      });
      assert.equal(stopRes.status, 200);
      const stopJson = await stopRes.json();
      assert.equal(stopJson.ok, true);
      assert.equal(stopJson.disarmed, true);
      assert.equal(stopJson.status.armed, false);
      assert.equal(stopJson.status.session.state, 'DISARMED');
      assert.ok(cancelledClOrdIds.includes(entryCall.body.clOrdId));
      assert.ok(stopJson.status.orders.some(o => o.client_order_id === entryCall.body.clOrdId && o.status === 'CANCELLED'));
      assert.ok(stopJson.status.orders.some(o => o.client_order_id === attachAlgo.attachAlgoClOrdId && o.order_type === 'oco_attached' && o.reduceOnly === true && o.status === 'CANCELLED'));

      // Re-arm before simulated server crash/restart so ARMED_RUNNING -> REARM_REQUIRED recovery is tested
      const rearmBeforeStop = await fetch(`${base}/api/autopilot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': tok1 },
        body: JSON.stringify({ armingPin, intervalSec: 5, simulatedEquityUsdt: 2400, runImmediately: false }),
      });
      assert.equal(rearmBeforeStop.status, 200);
      assert.equal((await rearmBeforeStop.json()).armed, true);
    } finally {
      await srv1.stop();
      store1.close();
    }

    // ---------------- Phase B: Restart Server #2 -> REARM_REQUIRED + Unlock ----------------
    const store2 = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const srv2 = createStandaloneServer({
      config: makeCfg(),
      store: store2,
      runtimeSpecs,
      exchangeClientFactory: ({ creds, maxLeverageCap, maxOrderUsdt }) => buildMockOkx({ creds, maxLeverageCap, maxOrderUsdt }),
    });

    try {
      const bound2 = await srv2.start();
      const base2 = `http://${bound2.host}:${bound2.port}`;

      // Server restart must transition ARMED_RUNNING -> REARM_REQUIRED
      const postRestartStatus = await (await fetch(`${base2}/api/autopilot/status`, {
        headers: { 'x-subscriber-token': tok1 },
      })).json();
      assert.equal(postRestartStatus.ok, true);
      assert.equal(postRestartStatus.armed, false);
      assert.equal(postRestartStatus.armedCount, 0);
      assert.equal(postRestartStatus.session.state, 'REARM_REQUIRED');
      assert.equal(postRestartStatus.session.disarm_reason, 'SERVER_RESTART_PIN_REARM_REQUIRED');
      assert.ok(postRestartStatus.events.some(e => e.event_type === 'REARM_REQUIRED'));

      // Unlock with wrong PIN -> 403
      const badUnlock = await fetch(`${base2}/api/commercial/subscribers/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: subId, armingPin: '000000' }),
      });
      assert.equal(badUnlock.status, 403);

      // Unlock with valid PIN -> 200 + rotated sessionToken
      const goodUnlockRes = await fetch(`${base2}/api/commercial/subscribers/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: subId, armingPin }),
      });
      assert.equal(goodUnlockRes.status, 200);
      const goodUnlock = await goodUnlockRes.json();
      assert.equal(goodUnlock.ok, true);
      assert.ok(goodUnlock.sessionToken);
      assert.notEqual(goodUnlock.sessionToken, tok1);
      tok2 = goodUnlock.sessionToken;

      // Old token rejected (401)
      const oldTokTry = await fetch(`${base2}/api/autopilot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': tok1 },
        body: JSON.stringify({ armingPin, runImmediately: false }),
      });
      assert.equal(oldTokTry.status, 401);

      // New rotated token re-arms cleanly
      const newTokStart = await fetch(`${base2}/api/autopilot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': tok2 },
        body: JSON.stringify({ armingPin, intervalSec: 5, simulatedEquityUsdt: 2400, runImmediately: false }),
      });
      assert.equal(newTokStart.status, 200);
      const newTokJson = await newTokStart.json();
      assert.equal(newTokJson.armed, true);
      assert.equal(newTokJson.session.state, 'ARMED_RUNNING');
    } finally {
      await srv2.stop();
      store2.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      store2.close();
    }

    // ---------------- Phase C: Raw .sqlite / -wal / -shm Byte Audit ----------------
    const sensitiveNeedles = [apiSecret, passphrase, armingPin, tok1, tok2, masterKey];
    const dbFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(p => fs.existsSync(p));
    assert.ok(dbFiles.length >= 1, 'Expected SQLite database file on disk');
    for (const f of dbFiles) {
      const rawBuf = fs.readFileSync(f);
      const rawUtf8 = rawBuf.toString('utf8');
      const rawLatin1 = rawBuf.toString('latin1');
      for (const secret of sensitiveNeedles) {
        assert.equal(rawUtf8.includes(secret), false, `Plaintext secret leaked (utf8) in ${path.basename(f)}`);
        assert.equal(rawLatin1.includes(secret), false, `Plaintext secret leaked (latin1) in ${path.basename(f)}`);
      }
    }
  });
});
