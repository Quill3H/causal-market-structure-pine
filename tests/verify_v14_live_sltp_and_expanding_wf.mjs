import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../standalone/config.mjs';
import { StandaloneStore } from '../standalone/store_sqlite.mjs';
import { loadRuntimeSpecs } from '../standalone/engine_runtime.mjs';
import { createStandaloneServer } from '../standalone/server.mjs';
import { runDoctor } from '../standalone/cli.mjs';
import { issueLicenseKey } from '../standalone/license_issuer.mjs';
import { CommercialPlatformEngine } from '../standalone/commercial_engine.mjs';
import { AutopilotScheduler } from '../standalone/autopilot-scheduler.mjs';
import { OkxClient, buildPostOnlyEntryOrder } from '../standalone/exchange_okx.mjs';
import { BinanceFuturesClient, hasBinanceProtectiveSlTp } from '../standalone/exchange_binance.mjs';
import { StandaloneOrderRouter, ROUTER_MODES } from '../standalone/order_router.mjs';

import {
  V14_STREAM_KEYS,
  applyV14ExpandingModelToSignals,
  loadModelsV14,
  verifyModelsLockV14,
} from '../research/expanding_wf_v14.mjs';
import {
  buildCausalBreadthV9,
  generateStreamSignalsV9,
  loadStreamDatasetV9,
  precomputeFeatureContextV9,
  extractCandidateFeaturesV9,
  sliceByMaxTimeV9,
} from '../research/ensemble_v9_walkforward.mjs';
import { alignFundingToBarsCausal } from '../research/fetch_okx_derivs.mjs';
import { precomputeAssetRegimeV8 } from '../research/regime_engine_v8.mjs';
import { scoreCandidateV5 } from '../research/ml_inference.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RESULTS_V9 = path.join(REPO_ROOT, 'research', 'results_v9');
const RESULTS_V14 = path.join(REPO_ROOT, 'research', 'results_v14');

function makeTmpDir(prefix = 'tt-v14-verify-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cloneMutatedFutureV14(ds, cutoffIdx) {
  const rows = ds.rows.map((r, idx) => {
    if (idx <= cutoffIdx) return { ...r };
    const mul = idx % 2 === 0 ? 1.85 : 0.48;
    const o = r.open * mul;
    const c = r.close * mul;
    return {
      ...r,
      open: o,
      high: Math.max(o, c) * 1.15,
      low: Math.min(o, c) * 0.85,
      close: c,
      volume: r.volume * 7.5,
      takerBuyVol: (r.takerBuyVol ?? r.volume * 0.5) * 7.5,
    };
  });
  const cutoffTime = ds.rows[cutoffIdx].time;
  const fundingRows = (ds.fundingRows ?? []).map(f => (
    f.time <= cutoffTime ? { ...f } : { ...f, fundingRate: -0.05 }
  ));
  return { ...ds, rows, fundingRows };
}

function makeFakeActiveOverlay(side = 1, price = 90000, barTime = 1767000000) {
  return {
    summary: { modelVersion: 'v14.0-ExpandingWF' },
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

function makeFlatOverlay(price = 90000) {
  return {
    summary: { modelVersion: 'v14.0-ExpandingWF' },
    regime: { regime: 'RANGE_CHOP', trendScore: 0, longPriority: 0, shortPriority: 0 },
    lastClose: price,
    activeOverlay: { status: 'FLAT' },
  };
}

function stripFencedAndTableSeparators(mdText) {
  const lines = mdText.split(/\r?\n/);
  let inFence = false;
  const prose = [];
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
    if (/^\s*---\s*$/.test(line)) continue;
    prose.push(line);
  }
  return prose.join('\n');
}

describe('1. OKX Atomic attachAlgoOrds (1-Call Entry + SL/TP) & Child Cancel Sync', () => {
  it('verifies buildPostOnlyEntryOrder, OkxClient.getPendingAlgoOrders, StandaloneOrderRouter attachSlTpOnEntry & CommercialPlatformEngine + AutopilotScheduler', async () => {
    const legacyPayload = buildPostOnlyEntryOrder({
      symbol: 'BTCUSDT.P',
      side: 1,
      sz: '0.10',
      px: '90000.0',
      clOrdId: 't14legacy1',
    });
    assert.equal(legacyPayload.attachAlgoOrds, undefined);

    const atomicPayload = buildPostOnlyEntryOrder({
      symbol: 'BTCUSDT.P',
      side: 1,
      sz: '0.10',
      px: '90000.0',
      clOrdId: 't14atomic1',
      slTriggerPx: '88200.0',
      tpTriggerPx: '92250.0',
      attachAlgoClOrdId: 't14algo1',
    });
    assert.ok(Array.isArray(atomicPayload.attachAlgoOrds) && atomicPayload.attachAlgoOrds.length === 1);
    assert.equal(atomicPayload.attachAlgoOrds[0].attachAlgoClOrdId, 't14algo1');
    assert.equal(atomicPayload.attachAlgoOrds[0].slTriggerPx, '88200.0');
    assert.equal(atomicPayload.attachAlgoOrds[0].tpTriggerPx, '92250.0');

    const tmp = makeTmpDir('tt-v14-okx-');
    const routerCalls = [];
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        EXCHANGE: 'OKX',
        OKX_API_KEY: 'okx_v14_k',
        OKX_API_SECRET: 'okx_v14_s',
        OKX_PASSPHRASE: 'okx_v14_p',
        OKX_SIMULATED: '1',
        EXECUTION_MODE: 'LIVE_ARMED',
        DRY_RUN: 'false',
        LIVE_CONFIRM_TOKEN: 'v14-okx-confirm',
        MAX_ORDER_USDT: '25000',
        COMMERCIAL_MASTER_KEY: 'v14-okx-master-key-32chars-minimum!!',
        COMMERCIAL_LICENSE_SECRET: 'v14-okx-license-secret',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'okx.sqlite'), allowedBaseDir: tmp });

    try {
      const routerClient = new OkxClient({
        apiKey: 'okx_v14_k',
        apiSecret: 'okx_v14_s',
        passphrase: 'okx_v14_p',
        simulated: true,
        dryRun: false,
        executionMode: 'LIVE_ARMED',
        liveConfirmToken: 'v14-okx-confirm',
        maxOrderUsdt: 25000,
        fetchImpl: async (url, init = {}) => {
          const u = String(url);
          if (u.includes('/api/v5/trade/orders-algo-pending')) {
            return { ok: true, status: 200, json: async () => ({ code: '0', data: [{ algoId: 'a1', ordType: 'oco' }] }) };
          }
          routerCalls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
          return { ok: true, status: 200, json: async () => ({ code: '0', data: [{ ordId: 'ordR1', sCode: '0' }] }) };
        },
      });
      assert.equal(routerClient.supportsAttachAlgoOrds, true);
      const pendingAlgos = await routerClient.getPendingAlgoOrders({ symbol: 'BTCUSDT.P' });
      assert.equal(pendingAlgos.length, 1);

      const router = new StandaloneOrderRouter({
        config: cfg,
        store,
        exchangeClient: routerClient,
        confirmToken: 'v14-okx-confirm',
      });
      const rAttached = await router.routeTransition({
        symbol: 'BTCUSDT.P',
        timeframe: '1h',
        activeOverlay: makeFakeActiveOverlay(1, 90000, 1767000000).activeOverlay,
        notionalUsdt: 900,
        attachSlTpOnEntry: true,
      });
      assert.equal(rAttached.action, 'SUBMITTED');
      assert.equal(routerCalls.length, 1);
      assert.ok(Array.isArray(routerCalls[0].body.attachAlgoOrds) && routerCalls[0].body.attachAlgoOrds.length === 1);

      // CommercialPlatformEngine + AutopilotScheduler disarm child cancel sync
      const engineTradeCalls = [];
      const engClient = new OkxClient({
        apiKey: 'okx_v14_eng_k',
        apiSecret: 'okx_v14_eng_s',
        passphrase: 'okx_v14_eng_p',
        simulated: true,
        dryRun: false,
        executionMode: 'LIVE_ARMED',
        liveConfirmToken: 'v14-okx-confirm',
        maxOrderUsdt: 25000,
        fetchImpl: async (url, init = {}) => {
          const u = String(url);
          if (u.includes('/api/v5/account/config')) {
            return { ok: true, status: 200, json: async () => ({ code: '0', data: [{ perm: 'read_only,trade' }] }) };
          }
          if (u.includes('/api/v5/account/balance')) {
            return { ok: true, status: 200, json: async () => ({ code: '0', data: [{ totalEq: '5000', details: [{ ccy: 'USDT', availEq: '4800' }] }] }) };
          }
          if (u.includes('/api/v5/account/positions')) {
            return { ok: true, status: 200, json: async () => ({ code: '0', data: [] }) };
          }
          engineTradeCalls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
          return { ok: true, status: 200, json: async () => ({ code: '0', data: [{ ordId: `ordE${engineTradeCalls.length}`, sCode: '0' }] }) };
        },
      });

      const engine = new CommercialPlatformEngine({ store, config: cfg });
      const scheduler = new AutopilotScheduler({ config: cfg, store, commercialEngine: engine });
      const lic = issueLicenseKey({
        planId: 'PRO_AUTO_TRADER',
        subscriberRef: 'v14okx@buyer.io',
        durationDays: 30,
        signingSecret: cfg.commercialLicenseSecret,
      }).licenseKey;

      const ob = await engine.onboardSubscriber({
        name: 'OKX Atomic Verify',
        licenseKey: lic,
        exchange: 'OKX',
        simulated: true,
        apiKey: 'okx_v14_eng_k',
        apiSecret: 'okx_v14_eng_s',
        passphrase: 'okx_v14_eng_p',
        armingPin: '2468',
        executionMode: 'DEMO_AUTO_TRADE',
        clientOverride: engClient,
        overlayOverrides: {
          'BTCUSDT.P': makeFlatOverlay(90000),
          'ETHUSDT.P': makeFlatOverlay(3000),
          'SOLUSDT.P': makeFlatOverlay(150),
          'BNBUSDT.P': makeFlatOverlay(600),
        },
      });
      const subId = ob.subscriber.subscriberId;

      const activeMap = {
        'BTCUSDT.P': makeFakeActiveOverlay(1, 90000, 1767003600),
        'ETHUSDT.P': makeFlatOverlay(3000),
        'SOLUSDT.P': makeFlatOverlay(150),
        'BNBUSDT.P': makeFlatOverlay(600),
      };
      const cycle = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '2468',
        clientOverride: engClient,
        overlayOverrides: activeMap,
      });
      assert.equal(cycle.executed, true);
      assert.equal(engineTradeCalls.length, 1);
      assert.equal(engineTradeCalls[0].url.endsWith('/api/v5/trade/order'), true);
      assert.ok(Array.isArray(engineTradeCalls[0].body.attachAlgoOrds) && engineTradeCalls[0].body.attachAlgoOrds.length === 1);
      const attAct = cycle.actions.find(a => a.action === 'SL_TP_ATTACHED_TO_ENTRY');
      assert.ok(attAct);
      assert.equal(attAct.clientOrderId, engineTradeCalls[0].body.attachAlgoOrds[0].attachAlgoClOrdId);
      const attRow = engine.cStore.findSubscriberOrder(attAct.clientOrderId, subId);
      assert.equal(attRow.order_type, 'oco_attached');
      assert.equal(attRow.status, 'ATTACHED_TO_ENTRY');

      // Disarm with cancelPendingEntries: true -> cancels parent AND marks attached child CANCELLED
      await scheduler.armSubscriber({
        subscriberId: subId,
        armingPin: '2468',
        executionMode: 'DEMO_AUTO_TRADE',
        clientOverride: engClient,
        overlayOverrides: activeMap,
        runImmediately: false,
      });
      await scheduler.disarmSubscriber(subId, {
        reason: 'VERIFY_CANCEL_CHILD',
        cancelPendingEntries: true,
        clientOverride: engClient,
      });
      assert.equal(engine.cStore.findSubscriberOrder(attAct.clientOrderId, subId).status, 'CANCELLED');
      scheduler.stop();
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('2. Binance Position-Aware Fill Sync (Deferral, Filled Qty Promotion, Dedup & Expiry Cancel)', () => {
  it('defers reduceOnly SL/TP until fill, syncs filled qty once, deduplicates via hasBinanceProtectiveSlTp & cancels unfilled watch', async () => {
    const tmp = makeTmpDir('tt-v14-bin-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        EXCHANGE: 'BINANCE',
        BINANCE_API_KEY: 'bin_v14_k',
        BINANCE_API_SECRET: 'bin_v14_s',
        BINANCE_TESTNET: 'true',
        EXECUTION_MODE: 'LIVE_ARMED',
        DRY_RUN: 'false',
        LIVE_CONFIRM_TOKEN: 'v14-bin-confirm',
        MAX_ORDER_USDT: '25000',
        COMMERCIAL_MASTER_KEY: 'v14-bin-master-key-32chars-minimum!!',
        COMMERCIAL_LICENSE_SECRET: 'v14-bin-license-secret',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'bin.sqlite'), allowedBaseDir: tmp });

    let openPositions = [];
    let openOrders = [];
    const postCalls = [];
    const deleteCalls = [];

    const binClient = new BinanceFuturesClient({
      apiKey: 'bin_v14_k',
      apiSecret: 'bin_v14_s',
      testnet: true,
      dryRun: false,
      executionMode: 'LIVE_ARMED',
      liveConfirmToken: 'v14-bin-confirm',
      maxOrderUsdt: 25000,
      fetchImpl: async (url, init = {}) => {
        const u = String(url);
        const method = String(init.method || 'GET').toUpperCase();
        const qs = new URLSearchParams(u.split('?')[1] || '');
        const rec = Object.fromEntries(qs.entries());
        if (u.includes('/fapi/v2/account')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              enableReading: true,
              enableFutures: true,
              enableWithdrawals: false,
              totalWalletBalance: '2500',
              availableBalance: '2400',
              positions: openPositions,
            }),
          };
        }
        if (u.includes('/fapi/v1/openOrders')) {
          return { ok: true, status: 200, text: async () => JSON.stringify(openOrders) };
        }
        if (u.includes('/fapi/v1/order') && method === 'GET') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ orderId: 9001, status: 'NEW', ...rec }) };
        }
        if (u.includes('/fapi/v1/order') && method === 'POST') {
          postCalls.push(rec);
          return { ok: true, status: 200, text: async () => JSON.stringify({ orderId: 8000 + postCalls.length, clientOrderId: rec.newClientOrderId }) };
        }
        if (u.includes('/fapi/v1/order') && method === 'DELETE') {
          deleteCalls.push(rec);
          return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'CANCELED', ...rec }) };
        }
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });

    try {
      // Direct helper + client coverage
      const ordSnap = await binClient.getOrder({ symbol: 'BTCUSDT.P', orderId: 9001 });
      assert.equal(ordSnap.status, 'NEW');
      assert.equal(hasBinanceProtectiveSlTp({ openOrders: [], symbol: 'BTCUSDT.P', entrySide: 1 }).fullyProtected, false);

      // StandaloneOrderRouter.syncFilledPositionProtection: flat -> NO_OPEN_POSITION, filled -> PROTECTIVE_SL_TP_SYNCED, protected -> ALREADY_PROTECTED
      const router = new StandaloneOrderRouter({
        config: cfg,
        store,
        exchangeClient: binClient,
        confirmToken: 'v14-bin-confirm',
      });
      const rFlat = await router.syncFilledPositionProtection({
        symbol: 'BTCUSDT.P',
        openPositions: [],
        openOrders: [],
        plannedStop: 88200,
        plannedTarget: 92250,
        barTime: 1767100000,
      });
      assert.equal(rFlat.action, 'NO_OPEN_POSITION');

      const rSync = await router.syncFilledPositionProtection({
        symbol: 'BTCUSDT.P',
        openPositions: [{ symbol: 'BTCUSDT', positionAmt: '0.005' }],
        openOrders: [],
        plannedStop: 88200,
        plannedTarget: 92250,
        barTime: 1767100000,
      });
      assert.equal(rSync.action, 'PROTECTIVE_SL_TP_SYNCED');
      assert.equal(postCalls.length, 2);
      assert.equal(postCalls[0].type, 'STOP_MARKET');
      assert.equal(postCalls[0].quantity, '0.005');
      assert.equal(postCalls[1].type, 'TAKE_PROFIT_MARKET');
      assert.equal(postCalls[1].quantity, '0.005');

      const rDupProt = await router.syncFilledPositionProtection({
        symbol: 'BTCUSDT.P',
        openPositions: [{ symbol: 'BTCUSDT', positionAmt: '0.005' }],
        openOrders: [
          { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', reduceOnly: 'true' },
          { symbol: 'BTCUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', reduceOnly: 'true' },
        ],
        plannedStop: 88200,
        plannedTarget: 92250,
        barTime: 1767100000,
      });
      assert.equal(rDupProt.action, 'ALREADY_PROTECTED');
      assert.equal(postCalls.length, 2);

      // CommercialPlatformEngine lifecycle
      const engine = new CommercialPlatformEngine({ store, config: cfg });
      const lic = issueLicenseKey({
        planId: 'PRO_AUTO_TRADER',
        subscriberRef: 'v14bin@buyer.io',
        durationDays: 30,
        signingSecret: cfg.commercialLicenseSecret,
      }).licenseKey;

      const flatMap = {
        'BTCUSDT.P': makeFlatOverlay(90000),
        'ETHUSDT.P': makeFlatOverlay(3000),
        'SOLUSDT.P': makeFlatOverlay(150),
        'BNBUSDT.P': makeFlatOverlay(600),
      };
      const ob = await engine.onboardSubscriber({
        name: 'Binance Verify',
        licenseKey: lic,
        exchange: 'BINANCE',
        simulated: true,
        apiKey: 'bin_v14_k',
        apiSecret: 'bin_v14_s',
        armingPin: '1357',
        executionMode: 'DEMO_AUTO_TRADE',
        clientOverride: binClient,
        overlayOverrides: flatMap,
      });
      const subId = ob.subscriber.subscriberId;

      const activeBtc = {
        ...flatMap,
        'BTCUSDT.P': makeFakeActiveOverlay(1, 90000, 1767200000),
      };

      // Cycle 1: no open position -> places LIMIT_GTX only, defers SL/TP as PENDING_FILL_WATCH (zero -2022 calls)
      const c1 = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '1357',
        clientOverride: binClient,
        overlayOverrides: activeBtc,
      });
      assert.equal(c1.executed, true);
      assert.equal(postCalls.length, 3);
      assert.equal(postCalls[2].type, 'LIMIT');
      assert.equal(postCalls[2].timeInForce, 'GTX');
      const watchAct = c1.actions.find(a => a.action === 'SL_TP_DEFERRED_UNTIL_FILL');
      assert.ok(watchAct);
      assert.equal(engine.cStore.findSubscriberOrder(watchAct.clientOrderId, subId).status, 'PENDING_FILL_WATCH');

      // Cycle 2: partial fill appears -> promotes PENDING_FILL_WATCH -> PROTECTIVE_SL_TP_SYNCED sized to 0.008
      openPositions = [{ symbol: 'BTCUSDT', positionAmt: '0.008' }];
      const c2 = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '1357',
        clientOverride: binClient,
        overlayOverrides: activeBtc,
      });
      assert.equal(c2.executed, true);
      const syncAct = c2.actions.find(a => a.action === 'PROTECTIVE_SL_TP_SYNCED');
      assert.ok(syncAct);
      assert.equal(syncAct.qty, '0.008');
      assert.equal(postCalls.length, 5);
      assert.equal(postCalls[3].type, 'STOP_MARKET');
      assert.equal(postCalls[3].quantity, '0.008');
      assert.equal(postCalls[4].type, 'TAKE_PROFIT_MARKET');
      assert.equal(postCalls[4].quantity, '0.008');
      assert.equal(engine.cStore.findSubscriberOrder(watchAct.clientOrderId, subId).status, 'SUBMITTED');

      // Cycle 3: openOrders already reports SL + TP -> skips duplicate protection calls
      openOrders = [
        { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', reduceOnly: 'true' },
        { symbol: 'BTCUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', reduceOnly: 'true' },
      ];
      const c3 = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '1357',
        clientOverride: binClient,
        overlayOverrides: activeBtc,
      });
      assert.equal(c3.executed, true);
      assert.equal(postCalls.length, 5, 'Duplicate cycle must not re-send SL/TP when exchange protection exists');

      // Cycle 4: new unfilled signal on ETH -> expires -> SL_TP_WATCH_CANCELLED
      openPositions = [];
      openOrders = [];
      const activeEth = { ...flatMap, 'ETHUSDT.P': makeFakeActiveOverlay(1, 3000, 1767300000) };
      const c4 = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '1357',
        clientOverride: binClient,
        overlayOverrides: activeEth,
      });
      const ethWatch = c4.actions.find(a => a.action === 'SL_TP_DEFERRED_UNTIL_FILL' && a.symbol === 'ETHUSDT.P');
      assert.ok(ethWatch);

      const c5 = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '1357',
        clientOverride: binClient,
        overlayOverrides: flatMap,
      });
      assert.equal(c5.actions.some(a => a.action === 'CANCELLED_STALE' && a.symbol === 'ETHUSDT.P'), true);
      assert.equal(c5.actions.some(a => a.action === 'SL_TP_WATCH_CANCELLED' && a.clientOrderId === ethWatch.clientOrderId), true);
      assert.equal(engine.cStore.findSubscriberOrder(ethWatch.clientOrderId, subId).status, 'CANCELLED');
      assert.ok(deleteCalls.some(d => d.symbol === 'ETHUSDT'));
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('3. v14.0 Expanding Walk-Forward Causality, Zero-Lookahead Purge, Parity & Zero-Liq', () => {
  it('verifies SHA-256 lock, purge invariants, abstention gates, prefix/mutation causality & 61-month zero-liq Y5 improvement', () => {
    const modelsJson = loadModelsV14();
    assert.equal(verifyModelsLockV14(modelsJson), modelsJson.selectionLockSha256);

    for (const sk of V14_STREAM_KEYS) {
      const sm = modelsJson.models[sk];
      assert.ok(sm && Array.isArray(sm.epochs) && sm.epochs.length === 7, `${sk} expected 7 epochs`);
      for (const ep of sm.epochs) {
        if (ep.trainSamplesCount > 0) {
          assert.ok(ep.maxTrainExitTime <= ep.epochStartTimeSec, `${sk} ${ep.label} exit time leak`);
          assert.ok(ep.maxTrainExitIndex < ep.epochStartBarIndex, `${sk} ${ep.label} exit index leak`);
        }
        if (ep.abstain) {
          assert.equal(ep.qualified, false);
        } else {
          assert.ok(ep.modelSpec.threshold >= 0.52, `${sk} ${ep.label} threshold < 0.52`);
          assert.ok(ep.chronoCvAuc >= 0.52, `${sk} ${ep.label} chronoCvAuc < 0.52`);
          assert.ok(ep.innerValTrades >= 4 && ep.innerValNetPct > 0 && ep.innerValPf >= 1.05);
        }
      }
      if (sm.liveActiveModel && !sm.liveActiveModel.abstain) {
        assert.ok(sm.liveActiveModel.modelSpec.threshold >= 0.52);
        assert.ok(sm.liveActiveModel.chronoCvAuc >= 0.52);
      }
    }

    // Prefix-truncation & future-mutation causality on applyV14ExpandingModelToSignals across all 8 streams
    const breadthFull = buildCausalBreadthV9(null);
    const btc1hFull = loadStreamDatasetV9('BTC_1h');
    const btc15Full = loadStreamDatasetV9('BTC_15m');

    for (const sk of V14_STREAM_KEYS) {
      const sm = modelsJson.models[sk];
      const dsFull = loadStreamDatasetV9(sk);
      const cutLen = Math.floor(dsFull.rows.length * 0.72);
      const cutoffTime = dsFull.rows[cutLen - 1].time;

      const dsPref = sliceByMaxTimeV9(dsFull, cutoffTime);
      const dsMut = cloneMutatedFutureV14(dsFull, cutLen - 1);

      const breadthPref = buildCausalBreadthV9(cutoffTime);
      const breadthMut = buildCausalBreadthV9(null, { BTC: dsMut.symbol === 'BTCUSDT' ? dsMut : cloneMutatedFutureV14(sk.endsWith('_15m') ? btc15Full : btc1hFull, Math.floor((sk.endsWith('_15m') ? btc15Full : btc1hFull).rows.length * 0.72) - 1) });

      const regFull = precomputeAssetRegimeV8(dsFull, breadthFull);
      const regPref = precomputeAssetRegimeV8(dsPref, breadthPref);
      const regMut = precomputeAssetRegimeV8(dsMut, sk.startsWith('BTC') ? breadthMut : breadthFull);

      const fundFull = alignFundingToBarsCausal(dsFull.rows, dsFull.fundingRows ?? []);
      const fundPref = alignFundingToBarsCausal(dsPref.rows, dsPref.fundingRows ?? []);
      const fundMut = alignFundingToBarsCausal(dsMut.rows, dsMut.fundingRows ?? []);

      const btcDsFull = sk.startsWith('ETH') ? (sk.endsWith('_15m') ? btc15Full : btc1hFull) : null;
      const btcDsPref = btcDsFull ? sliceByMaxTimeV9(btcDsFull, cutoffTime) : null;
      const btcDsMut = btcDsFull ? cloneMutatedFutureV14(btcDsFull, Math.floor(btcDsFull.rows.length * 0.72) - 1) : null;

      const sigSpec = sm.structuralSpec.sigSpec;
      const sigF = generateStreamSignalsV9(sk, dsFull, sigSpec, fundFull, regFull, btcDsFull).filter(s => dsFull.rows[s.barIndex].time <= cutoffTime);
      const sigP = generateStreamSignalsV9(sk, dsPref, sigSpec, fundPref, regPref, btcDsPref);
      const sigM = generateStreamSignalsV9(sk, dsMut, sigSpec, fundMut, regMut, btcDsMut).filter(s => dsMut.rows[s.barIndex].time <= cutoffTime);

      const mlF = applyV14ExpandingModelToSignals(sk, dsFull, sigF, fundFull, regFull, sm, cutoffTime);
      const mlP = applyV14ExpandingModelToSignals(sk, dsPref, sigP, fundPref, regPref, sm, cutoffTime);
      const mlM = applyV14ExpandingModelToSignals(sk, dsMut, sigM, fundMut, regMut, sm, cutoffTime);

      assert.equal(mlP.length, mlF.length, `${sk} v14 prefix ML length mismatch`);
      assert.equal(mlM.length, mlF.length, `${sk} v14 future-mut ML length mismatch`);
      for (let i = 0; i < mlF.length; i++) {
        assert.equal(mlP[i].barIndex, mlF[i].barIndex);
        assert.equal(mlM[i].barIndex, mlF[i].barIndex);
        assert.ok(Math.abs(mlP[i].meta.probWin - mlF[i].meta.probWin) < 1e-12);
        assert.ok(Math.abs(mlM[i].meta.probWin - mlF[i].meta.probWin) < 1e-12);
      }
    }

    // Zero-liquidation 61 UTC months + Blind Y5 improvement vs v9.0 across all 3 tiers
    const s14 = JSON.parse(fs.readFileSync(path.join(RESULTS_V14, 'expanding_wf_v14_crypto_5y.json'), 'utf8'));
    const s9 = JSON.parse(fs.readFileSync(path.join(RESULTS_V9, 'ensemble_v9_crypto_5y.json'), 'utf8'));

    for (const [t14, t9] of [['SAFE_V14', 'SAFE_V9'], ['BALANCED_V14', 'BALANCED_V9'], ['MAXIMIZED_V14', 'MAXIMIZED_V9']]) {
      for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
        const node14 = s14.tiers[t14].profiles[prof];
        assert.ok(node14.full5y_61m.count > 0);
        assert.equal(node14.calVal_49m.liquidationCount, 0);
        assert.equal(node14.oosExpanding60pct.liquidationCount, 0);
        assert.equal(node14.full5y_61m.liquidationCount, 0);
        assert.equal(node14.blindHoldoutY5_13m.liquidationCount, 0);
        if (prof === 'EXCHANGE_POST_ONLY') {
          const y5_14 = node14.blindHoldoutY5_13m.compoundedNetPct;
          const y5_9 = s9.tiers[t9].profiles.EXCHANGE_POST_ONLY.blindHoldoutY5_13m.compoundedNetPct;
          assert.ok(y5_14 > y5_9, `Expected ${t14} Y5 (${y5_14}) > ${t9} Y5 (${y5_9})`);
        }
      }
    }
    assert.equal(s14.crossAssetAllWeather.overlap2y.liquidationCount, 0);
    assert.equal(s14.crossAssetAllWeather.overlapY5Bear.liquidationCount, 0);
  });

  it('achieves < 1e-12 predict_proba & pass parity between Python sklearn and JS across active v14 models', () => {
    const modelsJson = loadModelsV14();
    const breadth = buildCausalBreadthV9(null);
    const btc1h = loadStreamDatasetV9('BTC_1h');
    const btc15 = loadStreamDatasetV9('BTC_15m');
    const tasks = [];

    for (const sk of V14_STREAM_KEYS) {
      const sm = modelsJson.models[sk];
      const ds = loadStreamDatasetV9(sk);
      const reg = precomputeAssetRegimeV8(ds, breadth);
      const fund = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
      const btcDs = sk.startsWith('ETH') ? (sk.endsWith('_15m') ? btc15 : btc1h) : null;
      const sigs = generateStreamSignalsV9(sk, ds, sm.structuralSpec.sigSpec, fund, reg, btcDs);
      const fCtx = precomputeFeatureContextV9(sk, ds, fund, reg, ds.rows[ds.rows.length - 1].time);
      const sampleSigs = sigs.slice(Math.max(0, sigs.length - 40));

      const allWindows = [
        ...sm.epochs.map(e => ({ tag: `${sk}:${e.label}`, ms: e.abstain ? null : e.modelSpec })),
        { tag: `${sk}:LiveActiveModel`, ms: sm.liveActiveModel && !sm.liveActiveModel.abstain ? sm.liveActiveModel.modelSpec : null },
      ].filter(w => w.ms);

      for (const w of allWindows) {
        const rows = sampleSigs.map(s => {
          const fMap = extractCandidateFeaturesV9(sk, ds, s, s.barIndex, fund, fCtx);
          const sc = scoreCandidateV5(fMap, w.ms);
          const vec = w.ms.featureNames.map(fn => (Number.isFinite(fMap[fn]) ? fMap[fn] : null));
          return { vec, jsProb: sc.probWin, jsPass: sc.pass };
        });
        tasks.push({ sk: w.tag, modelSpec: w.ms, rows });
      }
    }

    assert.ok(tasks.length >= 50, `Expected >= 50 active v14 epoch+live models, got ${tasks.length}`);

    const pyCode = `
import json, sys
import numpy as np
from scipy.special import expit
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

payload = json.loads(sys.stdin.read())
out = {}

def eval_tree(tree, x_f32):
    node = 0
    cl = tree['childrenLeft']
    cr = tree['childrenRight']
    feat = tree['feature']
    thresh = tree['threshold']
    val = tree['value']
    while True:
        f = feat[node]
        if f < 0:
            return float(val[node])
        if x_f32[f] <= thresh[node]:
            node = cl[node]
        else:
            node = cr[node]

for task in payload:
    sk = task['sk']
    ms = task['modelSpec']
    rows = task['rows']
    medians = np.array(ms['imputer']['medians'], dtype=np.float64)
    X_raw = np.array([[np.nan if v is None else float(v) for v in r['vec']] for r in rows], dtype=np.float64)
    for j in range(X_raw.shape[1]):
        mask = ~np.isfinite(X_raw[:, j])
        X_raw[mask, j] = medians[j]

    scaler = StandardScaler()
    scaler.mean_ = np.array(ms['scaler']['mean'], dtype=np.float64)
    scaler.scale_ = np.array(ms['scaler']['scale'], dtype=np.float64)
    scaler.var_ = scaler.scale_ ** 2
    scaler.n_features_in_ = len(medians)
    X_sc = scaler.transform(X_raw)

    if ms['modelType'] == 'logistic_regression':
        clf = LogisticRegression()
        clf.coef_ = np.array([ms['classifier']['coef']], dtype=np.float64)
        clf.intercept_ = np.array([ms['classifier']['intercept']], dtype=np.float64)
        clf.classes_ = np.array([0, 1])
        py_probs = clf.predict_proba(X_sc)[:, 1]
    elif ms['modelType'] == 'gradient_boosting':
        init_s = float(ms['classifier']['initScore'])
        lr = float(ms['classifier']['learningRate'])
        trees = ms['classifier']['trees']
        X_f32 = X_sc.astype(np.float32)
        py_probs = np.empty(len(X_f32), dtype=np.float64)
        for i in range(len(X_f32)):
            raw = init_s
            for tr in trees:
                raw += lr * eval_tree(tr, X_f32[i])
            py_probs[i] = float(expit(raw))
    else:
        raise ValueError(ms['modelType'])

    thresh = float(ms['threshold'])
    diffs = [abs(float(py_probs[i]) - float(rows[i]['jsProb'])) for i in range(len(rows))]
    pass_mismatch = sum(1 for i in range(len(rows)) if (float(py_probs[i]) >= thresh) != bool(rows[i]['jsPass']))
    out[sk] = {'count': len(rows), 'maxAbsDiff': max(diffs), 'passMismatch': pass_mismatch}

print(json.dumps(out))
`;
    const stdout = execFileSync('python3', ['-c', pyCode], {
      input: JSON.stringify(tasks),
      encoding: 'utf8',
    });
    const res = JSON.parse(stdout);
    for (const t of tasks) {
      const r = res[t.sk];
      assert.ok(r.maxAbsDiff < 1e-12, `${t.sk} maxAbsDiff ${r.maxAbsDiff} >= 1e-12`);
      assert.equal(r.passMismatch, 0, `${t.sk} passMismatch ${r.passMismatch}`);
    }
  });
});

describe('4. Live HTTP Server (v14), CLI Doctor, Matrix, Git Remote & Zero-Em-Dash Docs Audit', () => {
  it('serves /api/versions (11), /api/backtest?version=v14, /api/frontier?version=v14 & passes CLI/matrix/docs/git checks', async () => {
    const tmp = makeTmpDir('tt-v14-http-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        RISK_TIER: 'SAFE_75WR',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'v14_http.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      const versJson = await (await fetch(`${base}/api/versions`)).json();
      assert.equal(versJson.ok, true);
      assert.equal(versJson.versions.length, 11);
      assert.ok(versJson.versions.some(v => v.version === 'v14.0'));

      const btJson = await (await fetch(`${base}/api/backtest?symbol=BTCUSDT.P&timeframe=1h&version=v14`)).json();
      assert.equal(btJson.ok, true);
      assert.ok(String(btJson.summary.modelVersion).startsWith('v14.0'));
      assert.equal(btJson.summary.liquidationCount, 0);

      const frJson = await (await fetch(`${base}/api/frontier?version=v14&tier=SAFE_75WR`)).json();
      assert.equal(frJson.ok, true);
      assert.equal(frJson.ready, true);
      assert.equal(frJson.version, 'v14');
      assert.equal(frJson.selectedTier.full5y.liquidationCount, 0);
      assert.ok(frJson.selectedTier.oosExpanding60pct && frJson.selectedTier.oosExpanding60pct.compoundedNetPct > 100);
      assert.equal(frJson.abstentionSummary.mainEpochsEvaluated, 48);
      assert.ok(frJson.selectionLockSha256);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // Matrix check (11 versions, 0 NaN/Infinity, 0 null in v14.0)
    const matPath = path.join(RESULTS_V9, 'all_versions_comparison_matrix.json');
    const matRaw = fs.readFileSync(matPath, 'utf8');
    assert.equal(/\bNaN\b/.test(matRaw), false);
    assert.equal(/\bInfinity\b/.test(matRaw), false);
    const mat = JSON.parse(matRaw);
    assert.equal(mat.versions.length, 11);
    const v14Node = mat.versions.find(v => v.version === 'v14.0');
    assert.ok(v14Node && v14Node.verifiedFromArtifact === true);
    assert.equal(Object.keys(v14Node.metrics.streams).length, 8);
    assert.equal(JSON.stringify(v14Node.metrics).includes(':null'), false);

    // CLI doctor check in temp sqlite path
    const docTmp = makeTmpDir('tt-v14-doc-');
    try {
      const doc = await runDoctor({
        ...cfg,
        allowedDataDir: docTmp,
        sqlitePath: path.join(docTmp, 'doc.sqlite'),
      });
      assert.equal(doc.ok, true);
      assert.equal(doc.models.v14Engine, true);
      assert.equal(doc.models.v14ModelsReady, true);
      assert.equal(doc.models.v14FrontierReady, true);
    } finally {
      fs.rmSync(docTmp, { recursive: true, force: true });
    }

    // Git remote check
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    assert.equal(remoteUrl, 'https://github.com/Quill3H/causal-market-structure-pine.git');

    // Zero em-dash / prose double-hyphen check on v14 docs
    for (const rel of ['docs/V14_ATTACH_SLTP_AND_EXPANDING_WF_REPORT.md', 'README.md']) {
      const txt = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.equal(txt.includes('\u2014'), false, `${rel} contains em-dash`);
      const prose = stripFencedAndTableSeparators(txt);
      assert.equal(/(^|\s)--(\s|$)/.test(prose), false, `${rel} contains prose double-hyphen`);
    }
  });
});
