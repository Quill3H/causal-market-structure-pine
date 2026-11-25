import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertLiveOrderSafety,
  assertLoopbackHost,
  loadConfig,
  normalizeRiskTier,
  parseDotEnv,
  redactConfig,
  scrubSecrets,
} from './config.mjs';
import {
  BinanceFuturesClient,
  buildBinancePostOnlyEntryOrder,
  buildBinanceReduceOnlySlTpOrders,
  parseBinanceKline,
  signBinanceRequest,
  toBinanceSymbol,
} from './exchange_binance.mjs';
import {
  buildPostOnlyEntryOrder,
  buildReduceOnlySlTpOrders,
  OkxClient,
  signOkxRequest,
  toOkxInstId,
} from './exchange_okx.mjs';
import {
  buildDatasetFromCandles,
  computeLiquidationDistance,
  computeV8MacroRegimeRadar,
  evaluateStrategy,
  getAllVersionsMatrixPreview,
  loadOfflineOrDbDataset,
  loadRuntimeSpecs,
  normalizeAssetSymbol,
  runFrontierPortfolio,
  runV7FrontierPortfolio,
} from './engine_runtime.mjs';
import { runVersions } from './cli.mjs';
import {
  parseYahooChartResponse,
  resolveEquityInstrument,
  YahooEquitiesClient,
} from './market_equities.mjs';
import {
  isValidOkxClOrdId,
  makeClientOrderId,
  resolveRouterMode,
  ROUTER_MODES,
  StandaloneOrderRouter,
} from './order_router.mjs';
import { createStandaloneServer } from './server.mjs';
import { resolveSafeSqlitePath, StandaloneStore } from './store_sqlite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function makeTmpDir(prefix = 'tt5-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('1. Config, .env parsing & hard safety defaults', () => {
  it('parses .env without external deps and applies hard defaults without API keys', () => {
    const tmp = makeTmpDir();
    try {
      const envFile = path.join(tmp, '.env');
      fs.writeFileSync(
        envFile,
        [
          '# Sample config',
          'EXCHANGE=OKX',
          'export SYMBOLS="BTCUSDT.P,ETHUSDT.P"',
          "TIMEFRAMES='1h,15m'",
          'OKX_API_KEY=secret-key-12345',
          'OKX_API_SECRET=super-secret-xyz',
          'OKX_PASSPHRASE=my-passphrase',
          'LIVE_CONFIRM_TOKEN=confirm-9999',
        ].join('\n'),
      );

      const parsed = parseDotEnv(fs.readFileSync(envFile, 'utf8'));
      assert.equal(parsed.EXCHANGE, 'OKX');
      assert.equal(parsed.SYMBOLS, 'BTCUSDT.P,ETHUSDT.P');
      assert.equal(parsed.TIMEFRAMES, '1h,15m');

      const cfg = loadConfig({ cwd: tmp, envPath: envFile, useProcessEnv: false });
      assert.equal(cfg.executionMode, 'PAPER');
      assert.equal(cfg.dryRun, true);
      assert.equal(cfg.maxLeverageCap, 3.0);
      assert.equal(cfg.maxOrderUsdt, 500);
      assert.equal(cfg.host, '127.0.0.1');
      assert.equal(cfg.port, 4180);

      // Redaction & JSON.stringify never expose secrets
      const serialized = JSON.stringify(cfg);
      assert.ok(!serialized.includes('secret-key-12345'));
      assert.ok(!serialized.includes('super-secret-xyz'));
      assert.ok(!serialized.includes('my-passphrase'));
      assert.ok(!serialized.includes('confirm-9999'));
      assert.equal(redactConfig(cfg).okx.configured, true);

      const scrubbed = scrubSecrets('Auth failed for secret-key-12345 with my-passphrase', cfg);
      assert.ok(!scrubbed.includes('secret-key-12345'));
      assert.ok(!scrubbed.includes('my-passphrase'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects non-loopback host and enforces LIVE_ARMED interlocks', () => {
    assert.throws(() => assertLoopbackHost('0.0.0.0'), /Security policy violation/);
    assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');

    const tmp = makeTmpDir();
    try {
      const cfg = loadConfig({ cwd: tmp, useProcessEnv: false });
      // Default PAPER + DRY_RUN blocks live orders
      assert.throws(() => assertLiveOrderSafety(cfg, 'anything'), /EXECUTION_MODE/);

      cfg.executionMode = 'LIVE_ARMED';
      assert.throws(() => assertLiveOrderSafety(cfg, 'anything'), /DRY_RUN/);

      cfg.dryRun = false;
      cfg.liveConfirmToken = 'alpha-token-77';
      assert.throws(() => assertLiveOrderSafety(cfg, 'wrong-token'), /mismatch/);

      cfg.okx = { apiKey: 'k', apiSecret: 's', passphrase: 'p', simulated: true };
      assert.throws(() => assertLiveOrderSafety(cfg, 'alpha-token-77', { orderNotionalUsdt: 650 }), /MAX_ORDER_USDT/);
      assert.equal(assertLiveOrderSafety(cfg, 'alpha-token-77', { orderNotionalUsdt: 250 }), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('2. Exchange HMAC-SHA256 signing vectors & Dry-Run safety', () => {
  it('matches exact OKX V5 HMAC-SHA256 Base64 signature vector and Post-Only/reduceOnly payloads', async () => {
    const timestamp = '2026-11-25T07:00:00.000Z';
    const method = 'POST';
    const requestPath = '/api/v5/trade/order';
    const bodyObj = buildPostOnlyEntryOrder({
      symbol: 'BTCUSDT.P',
      side: 1,
      sz: '0.01',
      px: '90000',
      clOrdId: 'tt5ord1',
    });
    assert.equal(bodyObj.instId, 'BTC-USDT-SWAP');
    assert.equal(bodyObj.ordType, 'post_only');
    assert.equal(bodyObj.side, 'buy');

    const bodyStr = JSON.stringify(bodyObj);
    const expectedPrehash = `${timestamp}POST${requestPath}${bodyStr}`;
    const expectedSign = crypto.createHmac('sha256', 'okx-secret-key').update(expectedPrehash).digest('base64');

    const signed = signOkxRequest({
      method,
      requestPath,
      body: bodyObj,
      timestamp,
      apiKey: 'okx-key',
      apiSecret: 'okx-secret-key',
      passphrase: 'okx-pass',
      simulated: true,
    });
    assert.equal(signed.prehash, expectedPrehash);
    assert.equal(signed.signature, expectedSign);
    assert.equal(signed.headers['OK-ACCESS-KEY'], 'okx-key');
    assert.equal(signed.headers['OK-ACCESS-SIGN'], expectedSign);
    assert.equal(signed.headers['OK-ACCESS-TIMESTAMP'], timestamp);
    assert.equal(signed.headers['OK-ACCESS-PASSPHRASE'], 'okx-pass');
    assert.equal(signed.headers['x-simulated-trading'], '1');

    const sltp = buildReduceOnlySlTpOrders({
      symbol: 'BTCUSDT.P',
      entrySide: 1,
      sz: '0.01',
      slTriggerPx: 88500,
      tpTriggerPx: 92000,
    });
    assert.equal(sltp.reduceOnly, true);
    assert.equal(sltp.side, 'sell');
    assert.equal(sltp.ordType, 'oco');

    // Dry-run mode NEVER invokes fetchImpl for order placement
    let networkCalled = false;
    const okx = new OkxClient({
      apiKey: 'okx-key',
      apiSecret: 'okx-secret-key',
      passphrase: 'okx-pass',
      dryRun: true,
      executionMode: 'PAPER',
      fetchImpl: async () => {
        networkCalled = true;
        throw new Error('Must not call network in dryRun');
      },
    });
    const res = await okx.placePostOnlyEntry({ symbol: 'BTCUSDT.P', side: 1, sz: '0.01', px: '90000' });
    assert.equal(res.dryRun, true);
    assert.equal(res.body.ordType, 'post_only');
    assert.equal(networkCalled, false);
  });

  it('matches exact Binance USD-M Futures HMAC-SHA256 hex vector and GTX/reduceOnly payloads', async () => {
    const timestamp = 1764054000000;
    const order = buildBinancePostOnlyEntryOrder({
      symbol: 'BTCUSDT.P',
      side: -1,
      quantity: '0.005',
      price: '91000',
      newClientOrderId: 'bn5ord1',
    });
    assert.equal(order.symbol, 'BTCUSDT');
    assert.equal(order.side, 'SELL');
    assert.equal(order.type, 'LIMIT');
    assert.equal(order.timeInForce, 'GTX');

    const signed = signBinanceRequest({
      params: order,
      timestamp,
      recvWindow: 5000,
      apiKey: 'bn-key',
      apiSecret: 'bn-secret-key',
    });
    const expectedSig = crypto
      .createHmac('sha256', 'bn-secret-key')
      .update(signed.queryString)
      .digest('hex');
    assert.equal(signed.signature, expectedSig);
    assert.equal(signed.headers['X-MBX-APIKEY'], 'bn-key');
    assert.ok(signed.fullQueryString.endsWith(`&signature=${expectedSig}`));

    const sltpList = buildBinanceReduceOnlySlTpOrders({
      symbol: 'BTCUSDT.P',
      entrySide: -1,
      quantity: '0.005',
      stopPrice: 92500,
      takeProfitPrice: 89000,
    });
    assert.equal(sltpList.length, 2);
    assert.equal(sltpList[0].side, 'BUY');
    assert.equal(sltpList[0].reduceOnly, 'true');
    assert.equal(sltpList[1].reduceOnly, 'true');

    let networkCalled = false;
    const binance = new BinanceFuturesClient({
      apiKey: 'bn-key',
      apiSecret: 'bn-secret-key',
      dryRun: true,
      executionMode: 'PAPER',
      fetchImpl: async () => {
        networkCalled = true;
        throw new Error('Must not call network in dryRun');
      },
    });
    const res = await binance.placePostOnlyEntry({ symbol: 'BTCUSDT.P', side: 1, quantity: '0.005', price: '90000' });
    assert.equal(res.dryRun, true);
    assert.equal(res.params.timeInForce, 'GTX');
    assert.equal(networkCalled, false);
  });
});

describe('3. SQLite WAL persistence, path safety & crash recovery', () => {
  it('enforces WAL mode, path traversal guard, CRUD persistence, and crash recovery', () => {
    const tmp = makeTmpDir('tt5-db-');
    try {
      assert.throws(() => resolveSafeSqlitePath('../escape.sqlite', tmp), /escapes allowed directory/);
      assert.throws(() => resolveSafeSqlitePath('/etc/passwd', tmp), /escapes allowed directory/);

      const dbPath = path.join(tmp, 'standalone.sqlite');
      const store = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
      assert.equal(store.getJournalMode(), 'wal');

      store.upsertCandles({
        exchange: 'OKX',
        symbol: 'BTCUSDT.P',
        timeframe: '1h',
        rows: [
          { time: 1700000000, open: 35000, high: 35200, low: 34900, close: 35100, volume: 120 },
          { time: 1700003600, open: 35100, high: 35400, low: 35050, close: 35300, volume: 140 },
        ],
      });
      const candles = store.getCandles({ exchange: 'OKX', symbol: 'BTCUSDT.P', timeframe: '1h', limit: 10 });
      assert.equal(candles.length, 2);
      assert.equal(candles[1].close, 35300);

      store.upsertFundingRates({
        exchange: 'OKX',
        symbol: 'BTCUSDT.P',
        rows: [{ time: 1700006400, fundingRate: 0.00012, realizedRate: 0.00012 }],
      });
      assert.equal(store.getFundingRates({ exchange: 'OKX', symbol: 'BTCUSDT.P' }).length, 1);

      store.upsertSignalsAudit([
        {
          exchange: 'OKX',
          symbol: 'BTCUSDT.P',
          timeframe: '1h',
          barTime: 1700003600,
          barIndex: 1,
          side: 1,
          limitPrice: 35200,
          atr: 180,
          probWin: 0.72,
          modelVersion: 'v5.0-test',
          decision: 'ACCEPTED',
          sizeMult: 1.15,
          features: { fundingRate: 0.00012 },
        },
      ]);
      const sigs = store.getSignalsAudit({ exchange: 'OKX', symbol: 'BTCUSDT.P', timeframe: '1h' });
      assert.equal(sigs.length, 1);
      assert.equal(sigs[0].probWin, 0.72);

      store.savePaperState('OKX:BTCUSDT.P:1h', { openPosition: { side: 1, entry: 35200 } });
      assert.equal(store.loadPaperState('OKX:BTCUSDT.P:1h').state.openPosition.entry, 35200);

      // Simulate sudden termination during SUBMITTING order
      store.upsertOrderLog({
        clientOrderId: 'cl-crash-1',
        exchange: 'OKX',
        symbol: 'BTCUSDT.P',
        mode: 'PAPER',
        orderType: 'post_only',
        side: 'buy',
        price: 35200,
        qty: 0.01,
        reduceOnly: false,
        status: 'SUBMITTING',
      });
      store.close();

      // Reopen DB & run crash recovery
      const reopened = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
      const recoveredCount = reopened.recoverInterruptedOrders();
      assert.equal(recoveredCount, 1);
      const orders = reopened.getOrdersLog({ symbol: 'BTCUSDT.P' });
      assert.equal(orders[0].status, 'INTERRUPTED');
      reopened.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('4. HTTP 127.0.0.1 Command Center APIs & Zero-XSS static audit', () => {
  it('serves API endpoints on 127.0.0.1 without leaking secrets and enforces POST /api/mode gate', async () => {
    const tmp = makeTmpDir('tt5-http-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        EXECUTION_MODE: 'PAPER',
        DRY_RUN: 'true',
        LIVE_CONFIRM_TOKEN: 'secret-live-token-88',
        OKX_API_KEY: 'hidden-okx-key',
        OKX_API_SECRET: 'hidden-okx-secret',
        OKX_PASSPHRASE: 'hidden-okx-pass',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'http.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      assert.equal(bound.host, '127.0.0.1');
      const base = `http://${bound.host}:${bound.port}`;

      const statusRes = await fetch(`${base}/api/status`);
      assert.equal(statusRes.status, 200);
      const statusText = await statusRes.text();
      assert.ok(!statusText.includes('hidden-okx-key'));
      assert.ok(!statusText.includes('hidden-okx-secret'));
      assert.ok(!statusText.includes('hidden-okx-pass'));
      assert.ok(!statusText.includes('secret-live-token-88'));
      const statusJson = JSON.parse(statusText);
      assert.equal(statusJson.ok, true);
      assert.equal(statusJson.config.executionMode, 'PAPER');

      const candlesRes = await fetch(`${base}/api/candles?symbol=BTCUSDT.P&timeframe=1h&limit=50`);
      const candlesJson = await candlesRes.json();
      assert.equal(candlesJson.ok, true);
      assert.ok(candlesJson.candles.length > 0);

      const btRes = await fetch(`${base}/api/backtest?symbol=BTCUSDT.P&timeframe=1h`);
      const btJson = await btRes.json();
      assert.equal(btJson.ok, true);
      assert.ok(btJson.summary.count > 0);

      // Mode gate blocks wrong token
      const badModeRes = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionMode: 'LIVE_ARMED', dryRun: false, confirmToken: 'wrong' }),
      });
      assert.equal(badModeRes.status, 403);

      // Mode gate allows valid token + credentials, then switches back to PAPER
      const goodModeRes = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          executionMode: 'LIVE_ARMED',
          dryRun: false,
          confirmToken: 'secret-live-token-88',
        }),
      });
      assert.equal(goodModeRes.status, 200);
      const goodModeJson = await goodModeRes.json();
      assert.equal(goodModeJson.config.executionMode, 'LIVE_ARMED');

      const resetRes = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionMode: 'PAPER' }),
      });
      assert.equal(resetRes.status, 200);
      assert.equal((await resetRes.json()).config.executionMode, 'PAPER');

      // Static HTML & CSP check
      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      assert.equal(htmlRes.headers.get('x-frame-options'), 'DENY');
      assert.ok(htmlRes.headers.get('content-security-policy').includes("script-src 'self'"));
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes static Zero-XSS audit across standalone/public/', () => {
    const appJs = fs.readFileSync(path.join(HERE, 'public', 'app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8');

    const forbiddenPatterns = [
      /\.innerHTML\b/i,
      /\.outerHTML\b/i,
      /insertAdjacentHTML\b/i,
      /document\.write\b/i,
      /\beval\s*\(/i,
      /new\s+Function\b/i,
      /setHTMLUnsafe\b/i,
    ];
    for (const pat of forbiddenPatterns) {
      assert.equal(pat.test(appJs), false, `Forbidden DOM/XSS sink ${pat} found in public/app.js`);
    }
    assert.ok(appJs.includes('textContent'), 'Expected textContent usage in public/app.js');
    assert.ok(appJs.includes('createElement'), 'Expected createElement usage in public/app.js');

    // No inline <script> code or inline on* handlers in index.html
    assert.equal(/\son[a-z]+\s*=/i.test(indexHtml), false, 'Inline event handler found in index.html');
    const inlineScripts = indexHtml.match(/<script(?![^>]*\bsrc=)[^>]*>/gi);
    assert.equal(inlineScripts, null, 'Inline <script> tag without src found in index.html');
  });
});

describe('5. v6.0 BNB support, Yahoo Finance v8 equities & macro regime', () => {
  it('supports BNBUSDT / BNB-USDT-SWAP mapping and Binance takerBuyVol kline parsing', () => {
    assert.equal(toOkxInstId('BNBUSDT.P'), 'BNB-USDT-SWAP');
    assert.equal(toOkxInstId('BNB'), 'BNB-USDT-SWAP');
    assert.equal(toBinanceSymbol('BNBUSDT.P'), 'BNBUSDT');
    assert.equal(toBinanceSymbol('BNB-USDT-SWAP'), 'BNBUSDT');
    assert.equal(normalizeAssetSymbol('BNB'), 'BNBUSDT.P');
    assert.equal(normalizeAssetSymbol('^GSPC'), 'SPY');
    assert.equal(normalizeAssetSymbol('Dow Jones'), 'DIA');
    assert.equal(normalizeAssetSymbol('^NDX'), 'QQQ');

    const kline = parseBinanceKline([
      1700000000000,
      '245.5',
      '248.0',
      '244.1',
      '247.2',
      '12000.5',
      1700003599999,
      '2950000',
      842,
      '6700.25',
      '1650000',
      '0',
    ]);
    assert.equal(kline.takerBuyVol, 6700.25);
    assert.equal(kline.trades, 842);
  });

  it('parses Yahoo Finance v8 payloads, macro snapshot (^VIX/^TNX), and evaluates Equity ETF strategy', async () => {
    const mockChart = (closes) => ({
      chart: {
        result: [{
          timestamp: closes.map((_, idx) => 1700006400 + idx * 86400),
          indicators: {
            quote: [{
              open: closes.map(c => c * 0.998),
              high: closes.map(c => c * 1.005),
              low: closes.map(c => c * 0.992),
              close: closes,
              volume: closes.map(() => 50000000),
            }],
          },
        }],
      },
    });

    const parsedSpy = parseYahooChartResponse({
      chart: {
        result: [{
          timestamp: [1700006400, 1700092800, 1700179200],
          indicators: {
            quote: [{
              open: [450, null, 452],
              high: [452, 453, 455],
              low: [449, 450, 451],
              close: [451, NaN, 454],
              volume: [1e7, 0, 1.2e7],
            }],
          },
        }],
      },
    }, { interval: '1d' });
    assert.equal(parsedSpy.length, 2);
    assert.equal(resolveEquityInstrument('S&P 500').indexSymbol, '^GSPC');

    const client = new YahooEquitiesClient({
      fetchImpl: async (url) => {
        const isVix = url.includes('%5EVIX');
        const payload = isVix ? mockChart([16.2, 15.8]) : mockChart([4.25, 4.31]);
        return { ok: true, status: 200, json: async () => payload };
      },
    });
    const macro = await client.getMacroSnapshot();
    assert.equal(macro.vix, 15.8);
    assert.equal(macro.tnx, 4.31);

    // Synthetic 260 daily bars with weekends/gaps + pullback triggers
    const rows = [];
    let t = 1680048000;
    for (let i = 0; i < 260; i++) {
      // skip every 6th & 7th day like weekends
      t += (i % 5 === 0 && i > 0) ? 3 * 86400 : 86400;
      const base = 400 + i * 0.35;
      const dip = (i % 25 === 0 && i > 205) ? -6.5 : 0;
      const close = base + dip;
      const open = base;
      const high = Math.max(open, close) + 2.5;
      const low = dip < 0 ? close - 0.1 : Math.min(open, close) - 1.5;
      rows.push({ time: t, open, high, low, close, volume: 1000000 });
    }
    const ds = buildDatasetFromCandles({ symbol: 'SPY', timeframe: '1d', rows });
    assert.equal(ds.allowTimeGaps, true);
    assert.ok(ds.htf['1wk'].rows.length > 10);

    const tmp = makeTmpDir('tt6-eq-');
    try {
      const cfg = loadConfig({
        cwd: REPO_ROOT,
        useProcessEnv: false,
        envOverrides: { ALPACA_API_KEY: 'alp-secret-key', ALPACA_API_SECRET: 'alp-secret-val' },
      });
      assert.ok(!JSON.stringify(cfg).includes('alp-secret-key'));
      const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
      const evalRes = evaluateStrategy({
        dataset: ds,
        macroData: macro,
        timeframe: '1d',
        symbol: 'SPY',
        exchange: 'YAHOO',
        execProfile: 'EQUITY_ETF',
        config: cfg,
        runtimeSpecs,
      });
      assert.equal(evalRes.summary.symbol, 'SPY');
      assert.equal(evalRes.regime.vix, 15.8);
      assert.equal(evalRes.regime.tnx, 4.31);
      assert.ok(evalRes.signalsAudit.length >= 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('6. v7.0 Risk Tiers, Distance-to-Liquidation Buffer & /api/frontier', () => {
  it('validates RISK_TIER defaults, normalization, and liquidation buffer math', () => {
    assert.equal(normalizeRiskTier('SAFE_75WR'), 'SAFE_75WR');
    assert.equal(normalizeRiskTier('TIER_2_BALANCED_75WR'), 'BALANCED_75WR');
    assert.equal(normalizeRiskTier('30MO'), 'TARGET_30MO_75WR');
    assert.throws(() => normalizeRiskTier('YOLO_100X'), /Invalid RISK_TIER/);

    const tmp = makeTmpDir('tt7-cfg-');
    try {
      const cfg = loadConfig({ cwd: tmp, useProcessEnv: false, envOverrides: { RISK_TIER: 'BALANCED_75WR' } });
      assert.equal(cfg.riskTier, 'BALANCED_75WR');
      assert.equal(redactConfig(cfg).riskTier, 'BALANCED_75WR');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const longLiq = computeLiquidationDistance(
      { status: 'OPEN_POSITION', side: 1, entry: 100000, lev: 2.0 },
      100000,
      { mmr: 0.005 },
    );
    assert.equal(longLiq.liqPrice, 50500);
    assert.equal(longLiq.bufferPct, 49.5);
    assert.equal(longLiq.status, 'SAFE');

    const tightShortLiq = computeLiquidationDistance(
      { status: 'OPEN_POSITION', side: -1, entry: 100000, lev: 5.0 },
      115000,
      { mmr: 0.005 },
    );
    assert.equal(tightShortLiq.liqPrice, 119500);
    assert.ok(tightShortLiq.bufferPct > 0 && tightShortLiq.bufferPct < 10);
    assert.equal(tightShortLiq.status, 'TIGHT');
  });

  it('serves /api/frontier and allows safe riskTier switching in PAPER mode', async () => {
    const tmp = makeTmpDir('tt7-http-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: { HOST: '127.0.0.1', PORT: '0', EXECUTION_MODE: 'PAPER', DRY_RUN: 'true' },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'v7.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      const frontierRes = await fetch(`${base}/api/frontier?tier=SAFE_75WR&version=v7`);
      assert.equal(frontierRes.status, 200);
      const frontierJson = await frontierRes.json();
      assert.equal(frontierJson.ok, true);
      assert.equal(frontierJson.ready, true);
      assert.equal(frontierJson.riskTier, 'SAFE_75WR');
      assert.equal(frontierJson.selectedTier.full5y.liquidationCount, 0);
      assert.ok(frontierJson.selectedTier.full5y.winRatePct >= 75);
      assert.ok(Array.isArray(frontierJson.monthlyTable) && frontierJson.monthlyTable.length > 0);

      const switchTierRes = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riskTier: 'TARGET_30MO_75WR' }),
      });
      assert.equal(switchTierRes.status, 200);
      const switched = await switchTierRes.json();
      assert.equal(switched.config.riskTier, 'TARGET_30MO_75WR');
      assert.equal(switched.config.executionMode, 'PAPER');

      const directFrontier = runV7FrontierPortfolio({ runtimeSpecs, config: cfg, riskTier: 'TARGET_30MO_75WR', execProfile: 'EXCHANGE_POST_ONLY' });
      assert.equal(directFrontier.ready, true);
      assert.equal(directFrontier.riskTier, 'TARGET_30MO_75WR');
      assert.equal(directFrontier.selectedTier.full5y.liquidationCount, 0);
      assert.ok(directFrontier.selectedTier.calVal_48m.meanMonthlySweepPct >= 30);

      const takerFrontier = runV7FrontierPortfolio({ runtimeSpecs, config: cfg, riskTier: 'TARGET_30MO_75WR', execProfile: 'STRICT_TAKER' });
      assert.equal(takerFrontier.ready, true);
      assert.equal(takerFrontier.execProfile, 'STRICT_TAKER');
      assert.equal(takerFrontier.selectedTier.full5y.liquidationCount, 0);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('7. v8.0 Macro-Trend Regime Radar, /api/regime & v7/v8 Frontier Toggle', () => {
  it('computes v8.0 causal Macro-Trend Regime Radar for crypto & equities', async () => {
    const tmp = makeTmpDir('tt8-radar-');
    try {
      const cfg = loadConfig({ cwd: REPO_ROOT, useProcessEnv: false });
      assert.equal(cfg.executionMode, 'PAPER');
      assert.equal(cfg.riskTier, 'SAFE_75WR');

      const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
      assert.equal(runtimeSpecs.hasV8RegimeEngine, true);
      assert.equal(runtimeSpecs.hasV8Models, true);
      assert.equal(runtimeSpecs.hasV8Frontier, true);

      const btcRadar = computeV8MacroRegimeRadar({
        repoRoot: REPO_ROOT,
        runtimeSpecs,
        symbol: 'BTCUSDT.P',
        timeframe: '1h',
      });
      assert.equal(btcRadar.ready, true);
      assert.ok(['BULL_TREND', 'BEAR_TREND', 'BEAR_SQUEEZE', 'RANGE_CHOP'].includes(btcRadar.regime));
      assert.ok(btcRadar.breadthBearPct >= 0 && btcRadar.breadthBearPct <= 100);
      assert.ok(btcRadar.longSizeMult >= 0 && btcRadar.shortSizeMult >= 0);
      assert.equal(btcRadar.coinsSummary.length, 4);

      const spyRadar = computeV8MacroRegimeRadar({
        repoRoot: REPO_ROOT,
        runtimeSpecs,
        symbol: 'SPY',
        timeframe: '1d',
      });
      assert.equal(spyRadar.ready, true);
      assert.ok(['BULL_TREND', 'BEAR_TREND', 'HIGH_VOL_CHOP'].includes(spyRadar.regime));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('serves /api/regime, toggles /api/frontier?version=v7|v8, and evaluates v8 strategy cleanly', async () => {
    const tmp = makeTmpDir('tt8-http-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: { HOST: '127.0.0.1', PORT: '0', EXECUTION_MODE: 'PAPER', DRY_RUN: 'true', RISK_TIER: 'SAFE_75WR' },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'v8.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      const regimeRes = await fetch(`${base}/api/regime?symbol=BTCUSDT.P&timeframe=1h`);
      assert.equal(regimeRes.status, 200);
      const regimeJson = await regimeRes.json();
      assert.equal(regimeJson.ok, true);
      assert.equal(regimeJson.radar.ready, true);
      assert.equal(regimeJson.radar.coinsSummary.length, 4);

      const v7Res = await fetch(`${base}/api/frontier?tier=SAFE_75WR&version=v7`);
      assert.equal(v7Res.status, 200);
      const v7Json = await v7Res.json();
      assert.equal(v7Json.ready, true);
      assert.equal(v7Json.version, 'v7');
      assert.equal(v7Json.selectedTier.full5y.liquidationCount, 0);

      const v8Res = await fetch(`${base}/api/frontier?tier=TARGET_30MO_75WR&version=v8`);
      assert.equal(v8Res.status, 200);
      const v8Json = await v8Res.json();
      assert.equal(v8Json.ready, true);
      assert.equal(v8Json.version, 'v8');
      assert.equal(v8Json.selectedTier.full5y.liquidationCount, 0);
      assert.ok(v8Json.selectedTier.calVal_48m.meanMonthlySweepPct >= 30);

      const directV8 = runFrontierPortfolio({ version: 'v8', runtimeSpecs, config: cfg, riskTier: 'SAFE_75WR' });
      assert.equal(directV8.ready, true);
      assert.equal(directV8.version, 'v8');
      assert.equal(directV8.selectedTier.full5y.liquidationCount, 0);

      const loaded = loadOfflineOrDbDataset({ store, config: cfg, symbol: 'BTCUSDT.P', timeframe: '1h' });
      const evalV8 = evaluateStrategy({
        dataset: loaded.dataset,
        fundingRates: loaded.fundingRates,
        macroData: loaded.macroData,
        timeframe: '1h',
        symbol: 'BTCUSDT.P',
        version: 'v8',
        config: cfg,
        runtimeSpecs,
      });
      assert.equal(evalV8.summary.modelVersion, 'v8.0-AsymmetricRegime');
      assert.equal(evalV8.summary.liquidationCount, 0);
      assert.ok(evalV8.summary.winRatePct >= 75);

      const statusRes = await fetch(`${base}/api/status?symbol=BTCUSDT.P&timeframe=1h`);
      assert.equal(statusRes.status, 200);
      const statusJson = await statusRes.json();
      assert.equal(statusJson.models.v8RegimeEngineReady, true);
      assert.equal(statusJson.models.v8ModelsReady, true);
      assert.equal(statusJson.models.v8FrontierReady, true);
      assert.equal(statusJson.v8Radar.ready, true);
      assert.equal(statusJson.config.executionMode, 'PAPER');
      assert.equal(statusJson.config.riskTier, 'SAFE_75WR');
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('8. Off-TV Order Router (OKX clOrdId, 3 Modes, Idempotency) & All-Versions Preview', () => {
  it('generates deterministic strictly alphanumeric OKX clOrdId (<=32 chars) and routes PAPER_ZERO_KEY idempotently', async () => {
    const id1 = makeClientOrderId({
      exchange: 'OKX',
      symbol: 'BTCUSDT.P',
      timeframe: '1h',
      barTime: 1795590000,
      side: 1,
      leg: 'E',
    });
    const id2 = makeClientOrderId({
      exchange: 'OKX',
      symbol: 'BTCUSDT.P',
      timeframe: '1h',
      barTime: 1795590000,
      side: 1,
      leg: 'E',
    });
    assert.equal(id1, id2);
    assert.ok(isValidOkxClOrdId(id1), `clOrdId "${id1}" failed ^[A-Za-z0-9]{1,32}$`);
    assert.equal(id1.includes('_'), false);
    assert.equal(id1.includes('-'), false);

    const tmp = makeTmpDir('tt9-paper-');
    const cfg = loadConfig({ cwd: tmp, useProcessEnv: false });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'router.sqlite'), allowedBaseDir: tmp });
    let networkTouched = false;
    const okxStub = new OkxClient({
      dryRun: true,
      executionMode: 'PAPER',
      fetchImpl: async () => {
        networkTouched = true;
        throw new Error('Must not touch network in PAPER_ZERO_KEY');
      },
    });
    try {
      assert.equal(resolveRouterMode(cfg).mode, ROUTER_MODES.PAPER_ZERO_KEY);
      const router = new StandaloneOrderRouter({ config: cfg, store, exchangeClient: okxStub });

      const pendingOverlay = {
        status: 'PENDING_LIMIT',
        side: 1,
        signalTime: 1795590000,
        limitPrice: 58500,
        stop: 57200,
        target: 60100,
        lev: 1.5,
      };
      const first = await router.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: pendingOverlay });
      assert.equal(first.mode, ROUTER_MODES.PAPER_ZERO_KEY);
      assert.equal(first.action, 'PAPER_SIMULATED');
      assert.equal(networkTouched, false);

      // Repeat same bar -> must skip idempotently
      const dup = await router.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: pendingOverlay });
      assert.equal(dup.action, 'IDEMPOTENT_SKIP');

      // Expire pending -> must log PAPER_CANCEL_SIMULATED
      const cancelled = await router.routeTransition({
        symbol: 'BTCUSDT.P',
        timeframe: '1h',
        activeOverlay: { status: 'FLAT' },
        previousOverlay: pendingOverlay,
      });
      assert.equal(cancelled.action, 'PAPER_CANCEL_SIMULATED');

      const logRows = store.getOrdersLog({ symbol: 'BTCUSDT.P', limit: 20 });
      assert.equal(logRows.length, 2);
      assert.ok(logRows.every(r => isValidOkxClOrdId(r.clientOrderId)));
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('routes OKX_DEMO_SIMULATED (x-simulated-trading: 1) and enforces LIVE_EXCHANGE_ARMED interlocks', async () => {
    const tmp = makeTmpDir('tt9-demo-');
    const demoCalls = [];
    const cfgDemo = loadConfig({
      cwd: tmp,
      useProcessEnv: false,
      envOverrides: {
        EXCHANGE: 'OKX',
        OKX_API_KEY: 'demo-key-123',
        OKX_API_SECRET: 'demo-secret-xyz',
        OKX_PASSPHRASE: 'demo-pass',
        OKX_SIMULATED: '1',
        EXECUTION_MODE: 'LIVE_ARMED',
        DRY_RUN: 'false',
        LIVE_CONFIRM_TOKEN: 'tok-okx-demo',
        MAX_LEVERAGE_CAP: '3.0',
        MAX_ORDER_USDT: '500',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'demo.sqlite'), allowedBaseDir: tmp });
    const mockClient = new OkxClient({
      apiKey: cfgDemo.okx.apiKey,
      apiSecret: cfgDemo.okx.apiSecret,
      passphrase: cfgDemo.okx.passphrase,
      simulated: true,
      dryRun: false,
      executionMode: 'LIVE_ARMED',
      liveConfirmToken: cfgDemo.liveConfirmToken,
      maxLeverageCap: cfgDemo.maxLeverageCap,
      maxOrderUsdt: cfgDemo.maxOrderUsdt,
      fetchImpl: async (url, init) => {
        demoCalls.push({ url, headers: init.headers, body: JSON.parse(init.body || '{}') });
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: '0', msg: '', data: [{ ordId: '99887766', algoId: '554433', sCode: '0' }] }),
        };
      },
    });

    try {
      assert.equal(resolveRouterMode(cfgDemo).mode, ROUTER_MODES.OKX_DEMO_SIMULATED);
      const router = new StandaloneOrderRouter({
        config: cfgDemo,
        store,
        exchangeClient: mockClient,
        confirmToken: 'tok-okx-demo',
      });

      const pendingOverlay = { status: 'PENDING_LIMIT', side: 1, signalTime: 1795600000, limitPrice: 59000, lev: 2.0 };
      const resEntry = await router.routeTransition({
        symbol: 'BTCUSDT.P',
        timeframe: '1h',
        activeOverlay: pendingOverlay,
        notionalUsdt: 150,
      });
      assert.equal(resEntry.action, 'SUBMITTED');
      assert.equal(demoCalls.length, 1);
      assert.equal(demoCalls[0].headers['x-simulated-trading'], '1');
      assert.equal(demoCalls[0].body.ordType, 'post_only');
      assert.ok(isValidOkxClOrdId(demoCalls[0].body.clOrdId));

      // Stale PENDING_LIMIT -> FLAT cancellation in OKX_DEMO_SIMULATED mode must succeed cleanly (no notional 0 rejection)
      const cancelRes = await router.routeTransition({
        symbol: 'BTCUSDT.P',
        timeframe: '1h',
        activeOverlay: { status: 'FLAT' },
        previousOverlay: pendingOverlay,
      });
      assert.equal(cancelRes.action, 'CANCELLED');
      assert.equal(demoCalls.length, 2);
      assert.equal(demoCalls[1].url.endsWith('/api/v5/trade/cancel-order'), true);
      assert.ok(isValidOkxClOrdId(demoCalls[1].body.clOrdId));

      // Filled position -> places reduceOnly OCO SL/TP
      const openOverlay = {
        status: 'OPEN_POSITION',
        side: 1,
        entryTime: 1795603600,
        entry: 59000,
        stop: 57500,
        target: 61000,
        lev: 2.0,
      };
      const resSlTp = await router.routeTransition({
        symbol: 'BTCUSDT.P',
        timeframe: '1h',
        activeOverlay: openOverlay,
        notionalUsdt: 150,
      });
      assert.equal(resSlTp.action, 'SUBMITTED');
      assert.equal(demoCalls.length, 3);
      assert.equal(demoCalls[2].body.ordType, 'oco');
      assert.equal(demoCalls[2].body.reduceOnly, true);

      // Flipping to LIVE_ARMED real mode must still enforce notional cap and token check
      cfgDemo.okx.simulated = false;
      assert.equal(resolveRouterMode(cfgDemo).mode, ROUTER_MODES.LIVE_EXCHANGE_ARMED);
      await assert.rejects(
        () => router.routeTransition({
          symbol: 'ETHUSDT.P',
          timeframe: '1h',
          activeOverlay: { status: 'PENDING_LIMIT', side: -1, signalTime: 1795610000, limitPrice: 3100, lev: 2.0 },
          notionalUsdt: 9999,
        }),
        /MAX_ORDER_USDT/,
      );
      await assert.rejects(
        () => router.routeTransition({
          symbol: 'ETHUSDT.P',
          timeframe: '1h',
          activeOverlay: { status: 'PENDING_LIMIT', side: -1, signalTime: 1795610000, limitPrice: 3100, lev: 2.0 },
          notionalUsdt: 100,
          confirmToken: 'wrong-token',
        }),
        /LIVE_CONFIRM_TOKEN mismatch/,
      );
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('serves /api/versions, /api/orders, and runs cli.mjs versions cleanly', async () => {
    const tmp = makeTmpDir('tt9-http-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: { HOST: '127.0.0.1', PORT: '0', EXECUTION_MODE: 'PAPER', DRY_RUN: 'true', RISK_TIER: 'SAFE_75WR' },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'v9.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const router = new StandaloneOrderRouter({ config: cfg, store });
      await router.routeTransition({
        symbol: 'BTCUSDT.P',
        timeframe: '1h',
        activeOverlay: { status: 'PENDING_LIMIT', side: 1, signalTime: 1795620000, limitPrice: 58800, lev: 1.5 },
      });

      const bound = await srv.start();
      const base = `http://${bound.host}:${bound.port}`;

      const versionsRes = await fetch(`${base}/api/versions`);
      assert.equal(versionsRes.status, 200);
      const versionsJson = await versionsRes.json();
      assert.equal(versionsJson.ok, true);
      assert.ok(Array.isArray(versionsJson.okxKeyGuide) && versionsJson.okxKeyGuide.length >= 3);

      const ordersRes = await fetch(`${base}/api/orders?limit=20`);
      assert.equal(ordersRes.status, 200);
      const ordersJson = await ordersRes.json();
      assert.equal(ordersJson.ok, true);
      assert.equal(ordersJson.router.mode, ROUTER_MODES.PAPER_ZERO_KEY);
      assert.equal(ordersJson.count, 1);
      assert.ok(isValidOkxClOrdId(ordersJson.orders[0].clientOrderId));

      const v9FrontierRes = await fetch(`${base}/api/frontier?tier=SAFE_75WR&version=v9`);
      assert.equal(v9FrontierRes.status, 200);
      const v9FrontierJson = await v9FrontierRes.json();
      assert.equal(v9FrontierJson.ok, true);
      assert.equal(v9FrontierJson.ready, true);
      assert.equal(v9FrontierJson.version, 'v9');
      assert.equal(v9FrontierJson.selectedTier.full5y.liquidationCount, 0);
      assert.equal(v9FrontierJson.monthlyTable.length, 61);

      const v9BtRes = await fetch(`${base}/api/backtest?symbol=BTCUSDT.P&timeframe=1h&version=v9`);
      assert.equal(v9BtRes.status, 200);
      const v9BtJson = await v9BtRes.json();
      assert.equal(v9BtJson.ok, true);
      assert.equal(v9BtJson.summary.modelVersion, 'v9.0-WalkForwardEnsemble');
      assert.equal(v9BtJson.summary.liquidationCount, 0);

      // Simulate pre-crash SUBMITTING entry -> recoverInterruptedOrders() marks INTERRUPTED
      store.upsertOrderLog({
        clientOrderId: 'tt9OKBTC1hLEdeadbeef01',
        exchange: 'OKX',
        symbol: 'BTCUSDT.P',
        mode: ROUTER_MODES.OKX_DEMO_SIMULATED,
        orderType: 'post_only',
        side: 'buy',
        price: 58900,
        qty: 0.002,
        reduceOnly: false,
        status: 'SUBMITTING',
      });
      assert.equal(store.recoverInterruptedOrders(), 1);
      const afterCrash = store.getOrdersLog({ symbol: 'BTCUSDT.P', limit: 10 });
      assert.equal(afterCrash.find(r => r.clientOrderId === 'tt9OKBTC1hLEdeadbeef01')?.status, 'INTERRUPTED');

      const cliVersions = await runVersions({}, cfg);
      assert.ok(cliVersions.okxKeyGuide.length >= 3);
      const directPreview = await getAllVersionsMatrixPreview({ repoRoot: REPO_ROOT, runtimeSpecs });
      assert.ok(directPreview.okxKeyGuide.length >= 3);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
