import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../standalone/config.mjs';
import { StandaloneStore } from '../standalone/store_sqlite.mjs';
import {
  StandaloneTradingDaemon,
  evaluateStrategy,
  loadOfflineOrDbDataset,
  loadRuntimeSpecs,
} from '../standalone/engine_runtime.mjs';
import { createStandaloneServer } from '../standalone/server.mjs';
import { issueLicenseKey } from '../standalone/license_issuer.mjs';
import { CommercialStore } from '../standalone/commercial_store.mjs';
import { CommercialPlatformEngine } from '../standalone/commercial_engine.mjs';
import { AutopilotScheduler } from '../standalone/autopilot-scheduler.mjs';
import { OkxClient, buildReduceOnlySlTpOrders } from '../standalone/exchange_okx.mjs';
import { BinanceFuturesClient, buildBinanceReduceOnlySlTpOrders } from '../standalone/exchange_binance.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function makeTmpDir(prefix = 'tt-v13-verify-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeActiveOverlay(side = 1, price = 90000, barTime = 1766000000) {
  return {
    summary: { modelVersion: 'v9.0-WalkForwardEnsemble' },
    regime: {
      regime: side === 1 ? 'BULL_TREND' : 'BEAR_TREND',
      trendScore: 0.7 * side,
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
      probWin: 0.78,
    },
  };
}

describe('v13.0 Clean-Room Adversarial Security & Integrity Remediation', () => {
  it('Probes 1-8: enforces PII scoping, delete auth, takeover block, IDOR verify block, settings upgrade/lev clamp, TT10 anti-sharing, query auth & Origin CSRF', async () => {
    const tmp = makeTmpDir('tt-v13-http-');
    const dbPath = path.join(tmp, 'v13_adv.sqlite');
    const masterKey = 'v13-adv-master-key-32chars-minimum-ok!';
    const licenseSecret = 'v13-adv-license-hmac-secret-key';
    const adminToken = 'v13-adv-admin-token-secret';

    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        RISK_TIER: 'SAFE_75WR',
        LOCAL_QUICKSTART_ENABLED: 'true',
        COMMERCIAL_MASTER_KEY: masterKey,
        COMMERCIAL_LICENSE_SECRET: licenseSecret,
        COMMERCIAL_ADMIN_TOKEN: adminToken,
      },
    });
    const store = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const cStore = new CommercialStore(store);
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    let decryptedProbeCount = 0;

    const srv = createStandaloneServer({
      config: cfg,
      store,
      runtimeSpecs,
      exchangeClientFactory: () => {
        decryptedProbeCount += 1;
        return {
          async getApiKeyPermissions() {
            return { perm: 'read_only,trade' };
          },
          async getAccountHealth() {
            return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 5000, availEqUsdt: 4800, openPositions: [] };
          },
          async cancelOrder() {
            return { dryRun: false, exchange: 'OKX', data: [{ sCode: '0' }] };
          },
        };
      },
    });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      const victimLic = issueLicenseKey({
        planId: 'PRO_AUTO_TRADER',
        subscriberRef: 'alice.victim@example.com',
        durationDays: 30,
        signingSecret: licenseSecret,
      }).licenseKey;
      const tenantBLic = issueLicenseKey({
        planId: 'STARTER_SCAN_SIGNAL',
        subscriberRef: 'bob.tenant@example.com',
        durationDays: 30,
        signingSecret: licenseSecret,
      }).licenseKey;
      const otherLic = issueLicenseKey({
        planId: 'PRO_AUTO_TRADER',
        subscriberRef: 'mallory@example.com',
        durationDays: 30,
        signingSecret: licenseSecret,
      }).licenseKey;

      // Seed sandbox + Victim (Alice) + Tenant B (Bob)
      const sandboxRes = await (await fetch(`${base}/api/autopilot/demo-sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runImmediately: false }),
      })).json();
      assert.equal(sandboxRes.ok, true);

      const victimRes = await (await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Alice Victim',
          email: 'alice.victim@example.com',
          licenseKey: victimLic,
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_alice_pub_9f2a',
          apiSecret: 'alice_secret_never_leak',
          passphrase: 'alice_pass',
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin: '1122',
          autoStart: false,
          simulatedEquityUsdt: 5000,
        }),
      })).json();
      assert.equal(victimRes.ok, true);
      const victimId = victimRes.subscriber.subscriberId;
      const victimTok = victimRes.sessionToken;
      const victimRowBefore = cStore.getSubscriberById(victimId);

      const bobRes = await (await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bob Tenant',
          email: 'bob.tenant@example.com',
          licenseKey: tenantBLic,
          exchange: 'OKX',
          simulated: true,
          executionMode: 'SCAN_AND_SIGNAL_ONLY',
          armingPin: '3344',
          autoStart: false,
          simulatedEquityUsdt: 1000,
        }),
      })).json();
      assert.equal(bobRes.ok, true);
      const bobId = bobRes.subscriber.subscriberId;
      const bobTok = bobRes.sessionToken;

      // Probe 1a: Unauthenticated GET /api/autopilot/status masks real emails, hides sessions & events
      const unauthStatus = await (await fetch(`${base}/api/autopilot/status`)).json();
      assert.equal(unauthStatus.ok, true);
      assert.deepEqual(unauthStatus.sessions, []);
      assert.deepEqual(unauthStatus.events, []);
      assert.ok(Array.isArray(unauthStatus.savedProfiles));
      const victimProfile = unauthStatus.savedProfiles.find(p => p.subscriberId === victimId);
      assert.ok(victimProfile);
      assert.equal(victimProfile.email, 'al***@example.com');
      assert.equal(JSON.stringify(unauthStatus).includes('alice.victim@example.com'), false);
      const sandboxProfile = unauthStatus.savedProfiles.find(p => p.isPaperSandbox);
      assert.equal(sandboxProfile.email, 'paper-sandbox@local');

      // Probe 7: ?subscriberToken= query auth scopes status strictly to owner
      const queryAuthRes = await fetch(`${base}/api/autopilot/status?subscriberToken=${encodeURIComponent(victimTok)}`);
      assert.equal(queryAuthRes.status, 200);
      const queryAuthJson = await queryAuthRes.json();
      assert.equal(queryAuthJson.subscriberId, victimId);
      assert.equal(queryAuthJson.subscriber.email, 'alice.victim@example.com');
      assert.ok(queryAuthJson.sessions.every(s => s.subscriber_id === victimId));

      // Probe 8: Origin CSRF Guard blocks evil Origin even when Sec-Fetch-Site header is omitted
      const evilCsrfRes = await fetch(`${base}/api/autopilot/status`, { method: 'GET' });
      assert.equal(evilCsrfRes.status, 200);
      const evilPost = await fetch(`${base}/api/commercial/simulate-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ equityUsdt: 500 }),
      });
      assert.equal(evilPost.status, 403);

      // Probe 3: Takeover Block via connect-and-start with victim subscriberId / email / name+exchange
      const takeoverById = await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscriberId: victimId,
          name: 'Attacker',
          licenseKey: otherLic,
          exchange: 'OKX',
          simulated: true,
          armingPin: '9999',
          autoStart: false,
        }),
      });
      assert.equal(takeoverById.status, 403);

      const takeoverByEmail = await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Alice Victim',
          email: 'alice.victim@example.com',
          licenseKey: otherLic,
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_attacker_pub_0001',
          apiSecret: 'attacker_sec',
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin: '9999',
          autoStart: false,
        }),
      });
      assert.equal(takeoverByEmail.status, 200);
      const takeoverByEmailJson = await takeoverByEmail.json();
      assert.notEqual(takeoverByEmailJson.subscriber.subscriberId, victimId);
      const victimRowAfter = cStore.getSubscriberById(victimId);
      assert.equal(victimRowAfter.session_token_hash, victimRowBefore.session_token_hash);

      // Probe 4: Verify-Connection IDOR Block without token must return 401 and zero decryption
      const probeCountBeforeIdor = decryptedProbeCount;
      const idorVerify = await fetch(`${base}/api/autopilot/verify-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: victimId }),
      });
      assert.equal(idorVerify.status, 401);
      assert.equal(decryptedProbeCount, probeCountBeforeIdor);

      // Probe 5: Settings Self-Upgrade blocked (403) + 50x Leverage Clamped <= 3.0
      const selfUpgrade = await fetch(`${base}/api/autopilot/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': bobTok },
        body: JSON.stringify({ planId: 'INSTITUTIONAL_VIP' }),
      });
      assert.equal(selfUpgrade.status, 403);

      const levClampRes = await fetch(`${base}/api/autopilot/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': victimTok },
        body: JSON.stringify({ maxLeverageCap: 50 }),
      });
      assert.equal(levClampRes.status, 200);
      const levClampJson = await levClampRes.json();
      assert.ok(levClampJson.subscriber.maxLeverageCap <= 3.0);

      // Probe 6: TT10 License Anti-Sharing (second subscriber reusing victimLic fails 403)
      const sharedLicRes = await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'License Thief',
          email: 'thief@example.com',
          licenseKey: victimLic,
          exchange: 'OKX',
          simulated: true,
          armingPin: '7777',
          autoStart: false,
        }),
      });
      assert.equal(sharedLicRes.status, 403);

      // Probe 2: Delete Auth & Cross-Tenant Isolation
      const delNoAuth = await fetch(`${base}/api/autopilot/delete-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: victimId }),
      });
      assert.equal(delNoAuth.status, 401);

      const delWrongPin = await fetch(`${base}/api/autopilot/delete-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: victimId, armingPin: '0000' }),
      });
      assert.equal(delWrongPin.status, 403);

      const delCrossTenant = await fetch(`${base}/api/autopilot/delete-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': bobTok },
        body: JSON.stringify({ subscriberId: victimId }),
      });
      assert.equal(delCrossTenant.status, 403);

      // Valid owner token deletes Bob; valid owner armingPin deletes Alice
      const delBobByTok = await fetch(`${base}/api/autopilot/delete-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': bobTok },
        body: JSON.stringify({ subscriberId: bobId }),
      });
      assert.equal(delBobByTok.status, 200);
      assert.equal(cStore.getSubscriberById(bobId), null);

      const delAliceByPin = await fetch(`${base}/api/autopilot/delete-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: victimId, armingPin: '1122' }),
      });
      assert.equal(delAliceByPin.status, 200);
      assert.equal(cStore.getSubscriberById(victimId), null);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Probe 1b: returns savedProfiles: [] when LOCAL_QUICKSTART_ENABLED=false', async () => {
    const tmp = makeTmpDir('tt-v13-nolq-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        LOCAL_QUICKSTART_ENABLED: 'false',
        COMMERCIAL_MASTER_KEY: 'v13-nolq-master-key-32chars-minimum!',
        COMMERCIAL_LICENSE_SECRET: 'v13-nolq-license-secret',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'nolq.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;
      const lic = issueLicenseKey({ planId: 'PRO_AUTO_TRADER', subscriberRef: 'priv@example.com', durationDays: 30, signingSecret: cfg.commercialLicenseSecret }).licenseKey;
      await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Private User', email: 'priv@example.com', licenseKey: lic, armingPin: '2468', autoStart: false }),
      });

      const unauthStatus = await (await fetch(`${base}/api/autopilot/status`)).json();
      assert.equal(unauthStatus.localQuickstartEnabled, false);
      assert.deepEqual(unauthStatus.savedProfiles, []);
      assert.deepEqual(unauthStatus.sessions, []);
      assert.deepEqual(unauthStatus.events, []);

      const sandboxBlocked = await fetch(`${base}/api/autopilot/demo-sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(sandboxBlocked.status, 403);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Probes 9 & 10: routes version=v4.1 / v5 accurately without hijacking into v6.0 and syncs /api/mode -> daemon.cryptoClient', async () => {
    const tmp = makeTmpDir('tt-v13-rt-');
    const dbPath = path.join(tmp, 'rt.sqlite');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXCHANGE: 'OKX',
        OKX_API_KEY: 'mode-sync-okx-key',
        OKX_API_SECRET: 'mode-sync-okx-sec',
        OKX_PASSPHRASE: 'mode-sync-okx-pass',
        OKX_SIMULATED: '1',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        LIVE_CONFIRM_TOKEN: 'mode-sync-confirm-tok',
      },
    });
    const store = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const loaded = loadOfflineOrDbDataset({ store, config: cfg, symbol: 'BTCUSDT.P', timeframe: '1h', minBars: 300, prefer5y: false });

    const evV41 = evaluateStrategy({
      dataset: loaded.dataset,
      fundingRates: loaded.fundingRates,
      macroData: loaded.macroData,
      timeframe: '1h',
      symbol: 'BTCUSDT.P',
      exchange: 'OKX',
      version: 'v4.1',
      config: cfg,
      runtimeSpecs,
    });
    assert.ok(String(evV41.summary.modelVersion).startsWith('v4.1'), `Expected v4.1, got ${evV41.summary.modelVersion}`);

    const evV5 = evaluateStrategy({
      dataset: loaded.dataset,
      fundingRates: loaded.fundingRates,
      macroData: loaded.macroData,
      timeframe: '1h',
      symbol: 'BTCUSDT.P',
      exchange: 'OKX',
      version: 'v5',
      mlEnabled: true,
      config: cfg,
      runtimeSpecs,
    });
    assert.ok(String(evV5.summary.modelVersion).startsWith('v5.0'), `Expected v5.0, got ${evV5.summary.modelVersion}`);

    // Probe 10: /api/mode updates daemon.cryptoClient.dryRun & executionMode in lockstep
    const daemon = new StandaloneTradingDaemon({ config: cfg, store, runtimeSpecs });
    assert.equal(daemon.cryptoClient.executionMode, 'PAPER');
    assert.equal(daemon.cryptoClient.dryRun, true);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs, daemon });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      const armRes = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionMode: 'LIVE_ARMED', dryRun: false, confirmToken: 'mode-sync-confirm-tok' }),
      });
      assert.equal(armRes.status, 200);
      assert.equal(daemon.cryptoClient.executionMode, 'LIVE_ARMED');
      assert.equal(daemon.cryptoClient.dryRun, false);

      const paperRes = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionMode: 'PAPER', dryRun: true }),
      });
      assert.equal(paperRes.status, 200);
      assert.equal(daemon.cryptoClient.executionMode, 'PAPER');
      assert.equal(daemon.cryptoClient.dryRun, true);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Probe 11 & Guardrail 2: verifies non-null v9 streams matrix, real OKX/Binance permission queries, HTML 502 handling & fail-closed UNVERIFIED_PERMISSIONS', async () => {
    const matrix = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'research/results_v9/all_versions_comparison_matrix.json'), 'utf8'),
    );
    const rawMatrixText = JSON.stringify(matrix);
    assert.equal(rawMatrixText.includes('Expanding Walk-Forward Stacking'), false);
    const v9Node = matrix.versions.find(v => v.version === 'v9.0');
    assert.ok(v9Node.label.includes('3-Slice Cal/Val Sub-Period Screening'));
    const expectedStreams = ['BTC_1h', 'BNB_1h', 'SOL_1h', 'ETH_1h', 'BTC_15m', 'BNB_15m', 'SOL_15m', 'ETH_15m'];
    for (const sk of expectedStreams) {
      const s = v9Node.metrics?.streams?.[sk];
      assert.ok(s, `Missing v9 stream ${sk}`);
      assert.equal(typeof s.qualifiedForLive, 'boolean');
      assert.equal(typeof s.shortEnabled, 'boolean');
      assert.ok(Number.isFinite(s.cvRocAuc));
      assert.ok(Number.isFinite(s.cvWrPct));
      assert.ok(s.foldSummary && s.foldSummary.f1Bear2022 && s.foldSummary.f2Recov2023 && s.foldSummary.f3Val);
      assert.ok(s.holdoutY5PostOnly && Number.isFinite(s.holdoutY5PostOnly.winRatePct));
      assert.ok(s.full5yPostOnly && Number.isFinite(s.full5yPostOnly.winRatePct));
    }

    // Real OkxClient & BinanceFuturesClient getApiKeyPermissions() + HTML 502 resilience
    const okxWithdrawClient = new OkxClient({
      apiKey: 'okx_k', apiSecret: 'okx_s', passphrase: 'p', simulated: true,
      fetchImpl: async (url) => {
        assert.equal(String(url).includes('/api/v5/account/config'), true);
        return { ok: true, status: 200, json: async () => ({ code: '0', data: [{ perm: 'read_only,trade,withdraw', acctLv: '2' }] }) };
      },
    });
    const binHtml502Client = new BinanceFuturesClient({
      apiKey: 'bin_k', apiSecret: 'bin_s', testnet: true,
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => '<html><body>502 Bad Gateway</body></html>' }),
    });
    await assert.rejects(() => binHtml502Client.getApiKeyPermissions(), /502 Bad Gateway/);

    const binWithdrawClient = new BinanceFuturesClient({
      apiKey: 'bin_k', apiSecret: 'bin_s', testnet: true,
      fetchImpl: async (url) => {
        assert.equal(String(url).includes('/fapi/v2/account'), true);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ enableReading: true, enableFutures: true, enableWithdrawals: true }),
        };
      },
    });

    const tmp = makeTmpDir('tt-v13-g2-');
    const cfg = {
      repoRoot: REPO_ROOT,
      exchange: 'OKX',
      executionMode: 'PAPER',
      dryRun: true,
      riskTier: 'SAFE_75WR',
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
      commercialMasterKey: 'v13-g2-master-key-32chars-minimum-ok!!',
      commercialLicenseSecret: 'v13-g2-license-secret',
    };
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'g2.sqlite'), allowedBaseDir: tmp });
    const engine = new CommercialPlatformEngine({ store, config: cfg });

    try {
      await assert.rejects(
        () => engine.probeExchangeConnection({ exchange: 'OKX', clientOverride: okxWithdrawClient, simulatedEquityUsdt: 1000 }),
        /WITHDRAW permission enabled/,
      );
      await assert.rejects(
        () => engine.probeExchangeConnection({ exchange: 'BINANCE', clientOverride: binWithdrawClient, simulatedEquityUsdt: 1000 }),
        /WITHDRAW permission enabled/,
      );

      // Client without getApiKeyPermissions -> fail-closed UNVERIFIED_PERMISSIONS, withdrawBlocked: false
      const noPermClient = {
        async getAccountHealth() {
          return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 2000, availEqUsdt: 2000, openPositions: [] };
        },
      };
      const unverifiedProbe = await engine.probeExchangeConnection({
        exchange: 'OKX',
        clientOverride: noPermClient,
        simulatedEquityUsdt: 2000,
      });
      assert.equal(unverifiedProbe.withdrawBlocked, false);
      assert.equal(unverifiedProbe.permissionSummary, 'UNVERIFIED_PERMISSIONS');

      const lic = issueLicenseKey({ planId: 'PRO_AUTO_TRADER', subscriberRef: 'unverified@example.com', durationDays: 30, signingSecret: cfg.commercialLicenseSecret }).licenseKey;
      const onboarded = await engine.onboardSubscriber({
        name: 'Unverified Key Sub',
        licenseKey: lic,
        exchange: 'OKX',
        simulated: true,
        apiKey: 'okx_unverified_1234',
        apiSecret: 'okx_unverified_sec',
        passphrase: 'pass',
        armingPin: '1234',
        executionMode: 'SCAN_AND_SIGNAL_ONLY',
        clientOverride: noPermClient,
      });
      assert.equal(onboarded.subscriber.permissionSummary, 'UNVERIFIED_PERMISSIONS');
      assert.equal(onboarded.subscriber.hasWithdrawPerm, false);
      const g2Checklist = engine.buildGuardrailChecklist(onboarded.subscriber.subscriberId);
      const g2Row = g2Checklist.find(g => g.id === 'G2');
      assert.ok(g2Row && g2Row.ok === false, 'G2 checklist must fail-closed on UNVERIFIED_PERMISSIONS');

      // Force DEMO_AUTO_TRADE in DB and verify Guardrail 2 fail-closed blocks execution
      engine.cStore.updateSubscriberSettings(onboarded.subscriber.subscriberId, { executionMode: 'DEMO_AUTO_TRADE' });
      const blocked = await engine.runSubscriberAutoTradeCycle(onboarded.subscriber.subscriberId, {
        armingPin: '1234',
        clientOverride: noPermClient,
      });
      assert.equal(blocked.executed, false);
      assert.equal(blocked.blockedReason, 'GUARDRAIL_2_UNVERIFIED_KEY_PERMISSIONS');

      // Also verify Guardrail 6 blocks DB max_leverage_cap > 3.0
      const okClient = {
        async getApiKeyPermissions() { return { perm: 'read_only,trade' }; },
        async getAccountHealth() { return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 2000, availEqUsdt: 2000, openPositions: [] }; },
      };
      const lic2 = issueLicenseKey({ planId: 'PRO_AUTO_TRADER', subscriberRef: 'levcheck@example.com', durationDays: 30, signingSecret: cfg.commercialLicenseSecret }).licenseKey;
      const sub2 = await engine.onboardSubscriber({
        name: 'Lev Check',
        licenseKey: lic2,
        exchange: 'OKX',
        simulated: true,
        apiKey: 'okx_ok_5678',
        apiSecret: 'okx_ok_sec',
        passphrase: 'pass',
        armingPin: '4567',
        executionMode: 'DEMO_AUTO_TRADE',
        clientOverride: okClient,
      });
      store.db.prepare('UPDATE commercial_subscribers SET max_leverage_cap = 50 WHERE subscriber_id = ?').run(sub2.subscriber.subscriberId);
      const levBlocked = await engine.runSubscriberAutoTradeCycle(sub2.subscriber.subscriberId, {
        armingPin: '4567',
        clientOverride: okClient,
      });
      assert.equal(levBlocked.executed, false);
      assert.equal(levBlocked.blockedReason, 'GUARDRAIL_6_LEVERAGE_CAP_EXCEEDED');
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Probe 12: isolates SL/TP partial failure (entry stays SUBMITTED), attaches algoClOrdId/slClientOrderId & guards scheduler disarm race', async () => {
    // Builder clientOrderId attachments
    const okxBuilt = buildReduceOnlySlTpOrders({
      symbol: 'BTCUSDT.P', entrySide: 1, sz: '0.10', slTriggerPx: '88000', tpTriggerPx: '92000', algoClOrdId: 't10algo123',
    });
    assert.equal(okxBuilt.algoClOrdId, 't10algo123');
    assert.equal(okxBuilt.side, 'sell');

    const binBuilt = buildBinanceReduceOnlySlTpOrders({
      symbol: 'BTCUSDT.P', entrySide: 1, quantity: '0.005', stopPrice: '88000', takeProfitPrice: '92000', slClientOrderId: 't10binSL123',
    });
    assert.equal(binBuilt[0].newClientOrderId, 't10binSL123');
    assert.equal(binBuilt[1].newClientOrderId, 't10binSL123TP');

    const tmp = makeTmpDir('tt-v13-sltp-');
    const cfg = {
      repoRoot: REPO_ROOT,
      exchange: 'OKX',
      executionMode: 'PAPER',
      dryRun: true,
      riskTier: 'SAFE_75WR',
      maxLeverageCap: 3.0,
      maxOrderUsdt: 50000,
      commercialMasterKey: 'v13-sltp-master-key-32chars-minimum!!',
      commercialLicenseSecret: 'v13-sltp-license-secret',
    };
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'sltp.sqlite'), allowedBaseDir: tmp });
    const engine = new CommercialPlatformEngine({ store, config: cfg });
    const scheduler = new AutopilotScheduler({ config: cfg, store, commercialEngine: engine });

    try {
      const lic = issueLicenseKey({ planId: 'PRO_AUTO_TRADER', subscriberRef: 'sltp@example.com', durationDays: 30, signingSecret: cfg.commercialLicenseSecret }).licenseKey;
      const partialFailClient = {
        async getApiKeyPermissions() { return { perm: 'read_only,trade' }; },
        async getAccountHealth() { return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 5000, availEqUsdt: 5000, openPositions: [] }; },
        async placePostOnlyEntry() { return { dryRun: false, exchange: 'OKX', data: [{ ordId: 'entry_ok_1', sCode: '0' }] }; },
        async placeReduceOnlySlTp() { throw new Error('Simulated OCO placement failure'); },
        async cancelOrder() { return { dryRun: false, exchange: 'OKX', data: [{ sCode: '0' }] }; },
      };

      const subRes = await engine.onboardSubscriber({
        name: 'SLTP Partial',
        licenseKey: lic,
        exchange: 'OKX',
        simulated: true,
        apiKey: 'okx_partial_key_99',
        apiSecret: 'okx_partial_sec',
        passphrase: 'pass',
        armingPin: '6543',
        executionMode: 'DEMO_AUTO_TRADE',
        clientOverride: partialFailClient,
      });
      const subId = subRes.subscriber.subscriberId;
      const overlayOverrides = { 'BTCUSDT.P': makeFakeActiveOverlay(1, 90000, 1766003600) };

      const cycleRes = await engine.runSubscriberAutoTradeCycle(subId, {
        armingPin: '6543',
        clientOverride: partialFailClient,
        overlayOverrides,
      });
      assert.equal(cycleRes.executed, true);
      const entryAction = cycleRes.actions.find(a => a.action === 'SUBMITTED');
      const slFailAction = cycleRes.actions.find(a => a.action === 'SL_TP_REJECTED');
      assert.ok(entryAction, 'Entry order must stay SUBMITTED');
      assert.ok(slFailAction, 'Only SL/TP leg must report SL_TP_REJECTED');
      assert.equal(engine.cStore.findSubscriberOrder(entryAction.clientOrderId, subId).status, 'SUBMITTED');
      assert.equal(engine.cStore.findSubscriberOrder(slFailAction.clientOrderId, subId).status, 'REJECTED');

      // Scheduler race: disarming mid-tick returns DISARMED_DURING_TICK without re-writing ARMED_RUNNING
      await scheduler.armSubscriber({
        subscriberId: subId,
        armingPin: '6543',
        executionMode: 'DEMO_AUTO_TRADE',
        clientOverride: partialFailClient,
        overlayOverrides,
        runImmediately: false,
      });
      scheduler._syncMarketDataNonFatal = async () => {
        await scheduler.disarmSubscriber(subId, { reason: 'MID_TICK_DISARM' });
      };
      const tickRes = await scheduler.tickSubscriber(subId, { clientOverride: partialFailClient, overlayOverrides });
      assert.equal(tickRes.ticked, false);
      assert.equal(tickRes.skipped, true);
      assert.equal(tickRes.reason, 'DISARMED_DURING_TICK');
      assert.equal(engine.cStore.getAutopilotSession(subId).state, 'DISARMED');
    } finally {
      scheduler.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
