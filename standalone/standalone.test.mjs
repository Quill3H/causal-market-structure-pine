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
  evaluateStrategy,
  loadRuntimeSpecs,
  normalizeAssetSymbol,
} from './engine_runtime.mjs';
import {
  parseYahooChartResponse,
  resolveEquityInstrument,
  YahooEquitiesClient,
} from './market_equities.mjs';
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
