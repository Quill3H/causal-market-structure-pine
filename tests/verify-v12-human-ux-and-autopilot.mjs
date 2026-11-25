import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig, redactConfig } from '../standalone/config.mjs';
import { StandaloneStore } from '../standalone/store_sqlite.mjs';
import { loadRuntimeSpecs } from '../standalone/engine_runtime.mjs';
import { createStandaloneServer } from '../standalone/server.mjs';
import { ensureLocalServeSecrets } from '../standalone/cli.mjs';
import { decryptCredentials } from '../standalone/crypto_vault.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'standalone', 'public');
const DOCS_PATH = path.join(REPO_ROOT, 'docs', 'v11-e2e-autopilot-user-flow-guide.md');

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

const V12_DOM_IDS = [
  'e2e-paper-sandbox-btn',
  'theme-toggle-btn',
  'e2e-settings-dialog',
  'e2e-open-settings-btn',
  'e2e-quick-delete-profile-btn',
  'e2e-portfolio-hero',
  'e2e-equity-sparkline',
  'e2e-guardrails-details',
  'e2e-positions-table',
  'e2e-settings-form',
  'e2e-delete-profile-btn',
  'e2e-delete-confirm-btn',
];

const V12_5_DOM_IDS = [
  'pro-mode-toggle-btn',
  'workspace-tabs-nav',
  'e2e-show-connect-btn',
  'e2e-hide-connect-btn',
  'e2e-wizard-advanced-details',
  'e2e-simple-activity-card',
  'e2e-simple-activity-list',
  'e2e-tech-details',
  'e2e-settings-keys-details',
  'e2e-settings-adv-details',
  'e2e-switch-account-btn',
];

describe('v12.0 & v12.5 Human UX, Paper Sandbox, Settings, Keystore & Craft Audit', () => {
  const tmpDirs = [];
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('1. Frontend v12/v12.5 HTML/CSS/JS & Docs audit (DOM IDs, Consumer Mode default, Zero-XSS, modern-web-guidance, craft-floor, zero em-dashes)', () => {
    const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    const docsMd = fs.readFileSync(DOCS_PATH, 'utf8');

    // A) All 109 legacy + 22 v11 + 12 v12 + 11 v12.5 DOM IDs intact
    for (const domId of [...LEGACY_DOM_IDS, ...V11_DOM_IDS, ...V12_DOM_IDS, ...V12_5_DOM_IDS]) {
      assert.ok(indexHtml.includes(`id="${domId}"`), `Missing DOM id="${domId}" in standalone/public/index.html`);
    }

    // A2) v12.5 Consumer Mode default, 680px vs 1320px dashboard widths, tabs hidden when !proMode, zero nested .surface-block inside #e2e-tech-details
    const bodyTag = indexHtml.match(/<body\b[^>]*>/i)?.[0] || '';
    assert.equal(/\bpro-mode\b/.test(bodyTag), false, '<body> must not start in pro-mode by default');
    assert.match(appJs, /proMode:\s*false/);
    assert.match(appJs, /tabsNav\.classList\.toggle\('is-hidden',\s*!state\.proMode\)/);
    assert.match(stylesCss, /body:not\(\.pro-mode\)\s*\.dashboard\s*\{[^}]*max-width:\s*680px;/s);
    assert.match(stylesCss, /body\.pro-mode\s*\.dashboard\s*\{[^}]*max-width:\s*1320px;/s);

    const techStart = indexHtml.indexOf('<details id="e2e-tech-details"');
    const techEnd = indexHtml.indexOf('</details>\n      </section>', techStart);
    assert.ok(techStart !== -1 && techEnd > techStart, 'Expected #e2e-tech-details block in index.html');
    const techInner = indexHtml.slice(indexHtml.indexOf('>', techStart) + 1, techEnd);
    assert.equal(/\bsurface-block\b/.test(techInner), false, 'Zero nested .surface-block allowed inside #e2e-tech-details');

    // B) Zero-XSS static audit across standalone/public/*
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
    for (const file of fs.readdirSync(PUBLIC_DIR)) {
      const fullPath = path.join(PUBLIC_DIR, file);
      if (!fs.statSync(fullPath).isFile()) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pat of forbiddenSinks) {
        assert.equal(pat.test(content), false, `Forbidden XSS sink ${pat} in standalone/public/${file}`);
      }
      assert.equal(content.includes('\u2014'), false, `Em-dash found in standalone/public/${file}`);
    }
    assert.equal(/\son[a-z]+\s*=/i.test(indexHtml), false, 'Inline on* attribute found in index.html');
    assert.equal(/\sstyle\s*=/i.test(indexHtml), false, 'Inline style= attribute found in index.html');
    const scriptTags = indexHtml.match(/<script\b[^>]*>/gi) || [];
    for (const tag of scriptTags) {
      assert.ok(/\bsrc\s*=/i.test(tag), `Inline <script> without src found in index.html: ${tag}`);
    }

    // C) Modern web guidance: color-scheme light dark + meta sync, single-row underline tabs, native <dialog>, @container tables
    assert.ok(indexHtml.includes('<meta name="color-scheme" content="light dark">'));
    assert.ok(stylesCss.includes('color-scheme: light dark;'));
    assert.ok(stylesCss.includes('&:has(> head > meta[name="color-scheme"][content="light"])'));
    assert.ok(stylesCss.includes('&:has(> head > meta[name="color-scheme"][content="dark"])'));
    assert.ok(appJs.includes('theme-toggle-btn'));
    assert.ok(appJs.includes('tt12_theme'));

    assert.match(stylesCss, /\.workspace-tabs\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    assert.match(stylesCss, /\.tab-btn\[aria-selected="true"\]::after\s*\{[^}]*border-block-end:\s*3px\s+solid\s+var\(--accent\);/s);

    const dialogTagMatch = indexHtml.match(/<dialog\b[^>]*id="e2e-settings-dialog"[^>]*>/i);
    assert.ok(dialogTagMatch, 'Expected <dialog id="e2e-settings-dialog">');
    assert.equal(/\brole\s*=|\baria-modal\s*=/i.test(dialogTagMatch[0]), false, '<dialog> must not carry redundant role/aria-modal');
    assert.ok(indexHtml.includes('<form method="dialog">'));
    assert.ok(appJs.includes('.showModal('));
    assert.match(stylesCss, /\.settings-dialog:modal\s*\{[^}]*overscroll-behavior:\s*contain;/s);
    assert.match(stylesCss, /\.settings-dialog::backdrop\s*\{[^}]*overscroll-behavior:\s*contain;/s);

    assert.match(stylesCss, /@container\s*\(max-width:\s*560px\)/);
    assert.ok(stylesCss.includes('td:nth-child(1)::before { content: var(--label-1'));

    // D) Craft floor invariants: no gradients, no >1px border-left stripe, custom SVG brand mark
    assert.equal(/(linear|radial|conic)-gradient\s*\(/i.test(stylesCss), false, 'Gradient banned by craft floor');
    assert.equal(/border-left:\s*[2-9]\d*px/i.test(stylesCss), false, '>1px border-left stripe banned by craft floor');
    assert.ok(indexHtml.includes('class="brand-mark-svg"'));
    assert.equal(indexHtml.includes('>TT11<'), false, 'Legacy TT11 gradient box should be replaced');

    // E) Docs audit: zero em-dashes, accurate settings ID, and zero prose double-hyphens
    assert.equal(docsMd.includes('\u2014'), false, 'Em-dash found in docs/v11-e2e-autopilot-user-flow-guide.md');
    assert.equal(docsMd.includes('e2e-cockpit-settings-btn'), false, 'Stale e2e-cockpit-settings-btn ID found in docs');
    assert.ok(docsMd.includes('e2e-open-settings-btn'), 'Expected e2e-open-settings-btn ID in docs');
    let inCode = false;
    const docLines = docsMd.split('\n');
    for (let i = 0; i < docLines.length; i++) {
      const line = docLines[i];
      if (line.trim().startsWith('```')) {
        inCode = !inCode;
        continue;
      }
      if (inCode) continue;
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line) || /^\s*---+\s*$/.test(line)) continue;
      const stripped = line.replace(/`[^`]*`/g, '');
      assert.equal(/--/.test(stripped), false, `Prose double-hyphen found in docs line ${i + 1}: ${line}`);
    }
  });

  it('2. 1-Click $1,000 Paper Sandbox, telemetry, scheduler tick, in-place upgrade, settings & delete-profile, and friendly errors', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v12-flow-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'v12_flow.sqlite');
    const masterKey = 'v12-flow-master-key-32chars-minimum!!';
    const licenseSecret = 'v12-flow-license-secret-minimum-99';

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
        COMMERCIAL_MASTER_KEY: masterKey,
        COMMERCIAL_LICENSE_SECRET: licenseSecret,
      },
    });
    const store = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);

    const apiKey = 'okx_v12_upgrade_key_7788';
    const apiSecret = 'V12_UPGRADE_SECRET_NEVER_PLAINTEXT';
    const passphrase = 'V12_UPGRADE_PASS_NEVER_PLAINTEXT';
    const armingPin = '7319';

    const srv = createStandaloneServer({
      config: cfg,
      store,
      runtimeSpecs,
      exchangeClientFactory: () => ({
        async getAccountHealth() {
          return {
            exchange: 'OKX',
            configured: true,
            connected: true,
            simulated: true,
            totalEqUsdt: 3100,
            availEqUsdt: 2950,
            openPositions: [],
          };
        },
        async placePostOnlyEntry() {
          return { dryRun: true, exchange: 'OKX', data: [{ ordId: 'v12_ord_1', sCode: '0' }] };
        },
        async placeReduceOnlySlTp() {
          return { dryRun: true, exchange: 'OKX', data: [{ algoId: 'v12_algo_1', sCode: '0' }] };
        },
        async cancelOrder() {
          return { dryRun: true, exchange: 'OKX', data: [{ sCode: '0' }] };
        },
      }),
    });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      // 1) POST /api/autopilot/demo-sandbox ($1,000 zero-key Paper Sandbox + telemetry)
      const sbRes = await fetch(`${base}/api/autopilot/demo-sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: 'OKX' }),
      });
      assert.equal(sbRes.status, 200);
      const sb = await sbRes.json();
      assert.equal(sb.ok, true);
      assert.equal(sb.subscriber.email, 'paper-sandbox@local');
      assert.equal(sb.subscriber.executionMode, 'PAPER_AUTO_TRADE');
      assert.equal(sb.subscriber.isPaperSandbox, true);
      assert.equal(sb.autopilot.armed, true);
      assert.equal(sb.status.portfolioSummary.totalEquityUsdt, 1000);
      assert.ok(Array.isArray(sb.status.portfolioSummary.equitySparkline));
      assert.ok(Array.isArray(sb.status.scanHistory) && sb.status.scanHistory.length >= 1);
      assert.ok(Array.isArray(sb.status.activePositions));
      assert.equal(sb.status.guardrailChecklist.length, 7);
      assert.ok(sb.status.guardrailChecklist.every(g => g.ok === true));

      const sandboxSubId = sb.subscriber.subscriberId;
      const sandboxTok = sb.sessionToken;

      // Scheduler cycle over /api/autopilot/tick increments cycle_count and scanHistory
      const tickRes = await fetch(`${base}/api/autopilot/tick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': sandboxTok },
        body: JSON.stringify({}),
      });
      assert.equal(tickRes.status, 200);
      const tickJson = await tickRes.json();
      assert.equal(tickJson.ok, true);
      assert.ok(tickJson.status.session.cycle_count >= 2);
      assert.ok(tickJson.status.scanHistory.length >= 2);

      // 2) In-place connect-and-start upgrade (zero duplicate profiles)
      const upgRes = await fetch(`${base}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': sandboxTok },
        body: JSON.stringify({
          subscriberId: sandboxSubId,
          name: 'Upgraded v12 Trader',
          email: 'paper-sandbox@local',
          exchange: 'OKX',
          simulated: true,
          apiKey,
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin,
          intervalSec: 20,
          simulatedEquityUsdt: 3100,
        }),
      });
      assert.equal(upgRes.status, 200);
      const upg = await upgRes.json();
      assert.equal(upg.ok, true);
      assert.equal(upg.subscriber.subscriberId, sandboxSubId);
      assert.equal(upg.subscriber.executionMode, 'DEMO_AUTO_TRADE');
      assert.equal(upg.subscriber.keyMask, 'okx_****7788');
      assert.equal(upg.status.savedProfiles.length, 1);

      const activeTok = upg.sessionToken;

      // 3) POST /api/autopilot/settings updates metadata/risk/interval while preserving blank credentials
      const setRes = await fetch(`${base}/api/autopilot/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': activeTok },
        body: JSON.stringify({
          name: 'Renamed v12 Pro',
          riskTier: 'BALANCED_75WR',
          preferredVersion: 'v8',
          intervalSec: 45,
          apiKey: '',
          apiSecret: '',
          passphrase: '',
        }),
      });
      assert.equal(setRes.status, 200);
      const setJson = await setRes.json();
      assert.equal(setJson.ok, true);
      assert.equal(setJson.subscriber.name, 'Renamed v12 Pro');
      assert.equal(setJson.subscriber.riskTier, 'BALANCED_75WR');
      assert.equal(setJson.subscriber.preferredVersion, 'v8');
      assert.equal(setJson.subscriber.hasCredentials, true);
      assert.equal(setJson.subscriber.keyMask, 'okx_****7788');
      assert.equal(setJson.status.session.interval_sec, 45);

      // Verify credentials still decrypt intact after blank-key settings save
      const credRow = srv.autopilotScheduler.cStore.getEncryptedCredentials(sandboxSubId);
      const dec = decryptCredentials(credRow.envelope, masterKey, `${sandboxSubId}|OKX`);
      assert.equal(dec.apiSecret, apiSecret);
      assert.equal(dec.passphrase, passphrase);

      // 4) Friendly error payloads preserve { ok: false, error } + userMessage + recoveryHint
      const errWithdrawRes = await fetch(`${base}/api/autopilot/verify-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: 'OKX',
          apiKey: 'okx_wd_0011',
          apiSecret: 'secret_wd',
          passphrase: 'pass',
          rawPermissionPayload: { perm: 'read_only,trade,withdraw' },
        }),
      });
      assert.equal(errWithdrawRes.status, 403);
      const errWithdraw = await errWithdrawRes.json();
      assert.equal(errWithdraw.ok, false);
      assert.equal(typeof errWithdraw.error, 'string');
      assert.ok(errWithdraw.userMessage && errWithdraw.userMessage.length > 0);
      assert.ok(errWithdraw.recoveryHint && errWithdraw.recoveryHint.length > 0);

      const errPinRes = await fetch(`${base}/api/commercial/subscribers/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: sandboxSubId, armingPin: '9999' }),
      });
      assert.equal(errPinRes.status, 403);
      const errPin = await errPinRes.json();
      assert.equal(errPin.ok, false);
      assert.equal(typeof errPin.error, 'string');
      assert.ok(errPin.userMessage && errPin.userMessage.length > 0);
      assert.ok(errPin.recoveryHint && errPin.recoveryHint.length > 0);

      // 5) POST /api/autopilot/delete-profile disarms & cascade-deletes profile
      const delRes = await fetch(`${base}/api/autopilot/delete-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': activeTok },
        body: JSON.stringify({ subscriberId: sandboxSubId, cancelPendingEntries: true }),
      });
      assert.equal(delRes.status, 200);
      const delJson = await delRes.json();
      assert.equal(delJson.ok, true);
      assert.equal(delJson.deleted, true);
      assert.equal(delJson.status.savedProfiles.length, 0);
      assert.equal(delJson.status.armedCount, 0);
      assert.equal(srv.autopilotScheduler.cStore.getSubscriberById(sandboxSubId), null);
    } finally {
      await srv.stop();
      store.close();
    }
  });

  it('3. Persistent local keystore (.gitignore, chmod 0600, loadConfig() invariant, restart survival & zero plaintext SQLite audit)', async () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    assert.ok(gitignore.split(/\r?\n/).includes('.local-vault.secret'));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-v12-ks-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'ks_persist.sqlite');
    const secretFile = path.join(tmp, '.local-vault.secret');

    const apiSecret = 'KS_PERSIST_SECRET_NEVER_ON_SQLITE_DISK';
    const passphrase = 'KS_PERSIST_PASS_NEVER_ON_SQLITE_DISK';
    const armingPin = '4815';

    // Invariant: loadConfig() with no .env keeps masterKeyConfigured === false
    const cleanCfg = loadConfig({ cwd: tmp, useProcessEnv: false });
    assert.equal(redactConfig(cleanCfg).commercial.masterKeyConfigured, false);

    // Boot 1: generate .local-vault.secret and save encrypted profile
    const cfg1 = loadConfig({ cwd: tmp, useProcessEnv: false });
    const ks1 = ensureLocalServeSecrets(cfg1, { secretPath: secretFile });
    assert.equal(ks1.generated, true);
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    assert.ok(cfg1.commercialMasterKey.length >= 32);

    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const store1 = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const srv1 = createStandaloneServer({
      config: cfg1,
      store: store1,
      runtimeSpecs,
      exchangeClientFactory: () => ({
        async getAccountHealth() {
          return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 1800, availEqUsdt: 1700, openPositions: [] };
        },
      }),
    });

    let subId = '';
    let tok1 = '';
    try {
      const b1 = await srv1.start();
      const res = await fetch(`http://${b1.host}:${b1.port}/api/autopilot/connect-and-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Persistent Local User',
          exchange: 'OKX',
          simulated: true,
          apiKey: 'okx_persist_4455',
          apiSecret,
          passphrase,
          rawPermissionPayload: { perm: 'read_only,trade' },
          armingPin,
          autoStart: true,
          runImmediately: false,
          simulatedEquityUsdt: 1800,
        }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      subId = data.subscriber.subscriberId;
      tok1 = data.sessionToken;
    } finally {
      await srv1.stop();
      store1.close();
    }

    // Boot 2: reload .local-vault.secret, verify REARM_REQUIRED -> unlock with PIN -> decrypts cleanly
    const cfg2 = loadConfig({ cwd: tmp, useProcessEnv: false });
    assert.equal(redactConfig(cfg2).commercial.masterKeyConfigured, false);
    const ks2 = ensureLocalServeSecrets(cfg2, { secretPath: secretFile });
    assert.equal(ks2.generated, false);
    assert.equal(ks2.loaded, true);
    assert.equal(cfg2.commercialMasterKey, cfg1.commercialMasterKey);

    const store2 = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
    const srv2 = createStandaloneServer({
      config: cfg2,
      store: store2,
      runtimeSpecs,
      exchangeClientFactory: () => ({
        async getAccountHealth() {
          return { exchange: 'OKX', configured: true, connected: true, simulated: true, totalEqUsdt: 1800, availEqUsdt: 1700, openPositions: [] };
        },
      }),
    });

    let tok2 = '';
    try {
      const b2 = await srv2.start();
      const base2 = `http://${b2.host}:${b2.port}`;

      const statusRes = await fetch(`${base2}/api/autopilot/status`);
      const statusJson = await statusRes.json();
      assert.equal(statusJson.savedProfiles.length, 1);
      assert.equal(statusJson.savedProfiles[0].autopilotState, 'REARM_REQUIRED');

      const unlockRes = await fetch(`${base2}/api/commercial/subscribers/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberId: subId, armingPin }),
      });
      assert.equal(unlockRes.status, 200);
      const unlockJson = await unlockRes.json();
      tok2 = unlockJson.sessionToken;
      assert.notEqual(tok2, tok1);

      const startRes = await fetch(`${base2}/api/autopilot/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-subscriber-token': tok2 },
        body: JSON.stringify({ armingPin, runImmediately: false }),
      });
      assert.equal(startRes.status, 200);
      assert.equal((await startRes.json()).armed, true);
    } finally {
      await srv2.stop();
      store2.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      store2.close();
    }

    // Raw .sqlite / -wal / -shm byte audit: zero plaintext secrets
    const needles = [apiSecret, passphrase, armingPin, tok1, tok2, cfg1.commercialMasterKey];
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(p => fs.existsSync(p))) {
      const raw = fs.readFileSync(f).toString('utf8');
      for (const secret of needles) {
        assert.equal(raw.includes(secret), false, `Plaintext secret leaked in ${path.basename(f)}`);
      }
    }
  });
});
