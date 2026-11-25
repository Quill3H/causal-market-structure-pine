import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_V6_ASSETS,
  assertLoopbackHost,
  hasExchangeCredentials,
  normalizeRiskTier,
  redactConfig,
  RISK_TIER_SPECS,
  timingSafeTokenEqual,
} from './config.mjs';
import {
  computeLiquidationDistance,
  computeRegimeTelemetry,
  computeV8MacroRegimeRadar,
  createExchangeClient,
  evaluateStrategy,
  loadOfflineOrDbDataset,
  normalizeAssetSymbol,
  runFrontierPortfolio,
} from './engine_runtime.mjs';
import { isEquitySymbol } from './market_equities.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
});

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
});

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: String(message) });
}

function readJsonBody(req, maxBytes = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function serveStaticFile(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('..') || rel.includes('\0')) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    sendError(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(resolved).pipe(res);
}

export function createStandaloneServer({ config, store, runtimeSpecs, daemon, checkAccountHealth = false } = {}) {
  const host = assertLoopbackHost(config.host || '127.0.0.1');
  const port = Number(config.port ?? 4180);

  let cachedHealth = {
    checkedAt: null,
    exchange: config.exchange,
    configured: hasExchangeCredentials(config),
    connected: false,
    simulated: config.exchange === 'OKX' ? config.okx?.simulated : config.binance?.testnet,
    reason: hasExchangeCredentials(config)
      ? 'API credentials loaded (health pending)'
      : 'Public-market + PAPER mode (no API keys)',
  };

  async function refreshAccountHealthIfNeeded() {
    if (!checkAccountHealth || !hasExchangeCredentials(config)) return cachedHealth;
    try {
      const client = createExchangeClient(config);
      const health = await client.getAccountHealth();
      cachedHealth = { ...health, checkedAt: new Date().toISOString() };
    } catch (err) {
      cachedHealth = {
        ...cachedHealth,
        connected: false,
        reason: err.message,
        checkedAt: new Date().toISOString(),
      };
    }
    return cachedHealth;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || '/', `http://${host}:${port}`);
      const pathname = parsed.pathname;
      const symbol = normalizeAssetSymbol(parsed.searchParams.get('symbol') || config.symbols[0] || 'BTCUSDT.P');
      const isEq = isEquitySymbol(symbol);
      const exchange = isEq ? 'YAHOO' : config.exchange;
      const defaultTf = isEq ? '1d' : (config.timeframes[0] || '1h');
      const timeframe = (parsed.searchParams.get('timeframe') || defaultTf).toLowerCase();
      const limit = Math.min(2000, Math.max(10, Number(parsed.searchParams.get('limit') || 240)));

      if (req.method === 'GET' && pathname === '/api/status') {
        const accountHealth = await refreshAccountHealthIfNeeded();
        const paperRecord = store.loadPaperState(`${exchange}:${symbol}:${timeframe}`);
        const snap = daemon?.latestSnapshots?.get(`${symbol}:${timeframe}`);
        const summary = snap?.summary || paperRecord?.state?.summary || null;
        const activeOverlay = snap?.activeOverlay || paperRecord?.state?.activeOverlay || null;
        const regime = snap?.regime || paperRecord?.state?.regime || computeRegimeTelemetry({
          repoRoot: config.repoRoot,
          runtimeSpecs,
          symbol,
          timeframe,
        });
        let v8Radar = regime?.v8Radar || null;
        if (!v8Radar && runtimeSpecs?.hasV8RegimeEngine) {
          try {
            v8Radar = computeV8MacroRegimeRadar({
              repoRoot: config.repoRoot,
              runtimeSpecs,
              symbol,
              timeframe,
            });
          } catch {
            v8Radar = null;
          }
        }
        const liquidationDistance = snap?.liquidationDistance ||
          computeLiquidationDistance(activeOverlay, activeOverlay?.entry ?? activeOverlay?.limitPrice ?? 0);
        const frontier = runFrontierPortfolio({
          version: 'auto',
          runtimeSpecs,
          config,
          riskTier: config.riskTier,
        });
        sendJson(res, 200, {
          ok: true,
          timestamp: new Date().toISOString(),
          config: redactConfig(config),
          assets: ALL_V6_ASSETS,
          riskTiers: RISK_TIER_SPECS,
          accountHealth,
          models: {
            v5EngineReady: Boolean(runtimeSpecs?.hasV5Engine),
            v5MlReady: Boolean(runtimeSpecs?.hasV5Ml),
            v6EngineReady: Boolean(runtimeSpecs?.hasV6Engine),
            v6CryptoModelsReady: Boolean(runtimeSpecs?.hasV6CryptoModels),
            v6StockModelsReady: Boolean(runtimeSpecs?.hasV6StockModels),
            v7EngineReady: Boolean(runtimeSpecs?.hasV7Engine),
            v7ModelsReady: Boolean(runtimeSpecs?.hasV7Models),
            v7FrontierReady: Boolean(runtimeSpecs?.hasV7Frontier),
            v8RegimeEngineReady: Boolean(runtimeSpecs?.hasV8RegimeEngine),
            v8ModelsReady: Boolean(runtimeSpecs?.hasV8Models),
            v8FrontierReady: Boolean(runtimeSpecs?.hasV8Frontier),
            activeModelVersion: summary?.modelVersion || (runtimeSpecs?.hasV8Models ? 'v8.0-RegimeMax' : runtimeSpecs?.hasV7Models ? 'v7.0-HighWR' : runtimeSpecs?.hasV5Ml ? 'v5.0-ML' : 'v4.1-fallback'),
          },
          daemon: {
            lastSyncAt: daemon?.lastSyncAt || null,
            lastEvalAt: daemon?.lastEvalAt || null,
            lastError: daemon?.lastError || null,
          },
          regime,
          v8Radar,
          liquidationDistance,
          frontierSummary: frontier,
          summary,
          activeOverlay,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/regime') {
        let loaded = null;
        try {
          loaded = loadOfflineOrDbDataset({ store, config, symbol, timeframe, minBars: 60 });
        } catch {
          loaded = null;
        }
        const radar = computeV8MacroRegimeRadar({
          repoRoot: config.repoRoot,
          runtimeSpecs,
          dataset: loaded?.dataset || null,
          fundingRates: loaded?.fundingRates || [],
          macroData: loaded?.macroData || null,
          symbol,
          timeframe,
        });
        const telemetry = computeRegimeTelemetry({
          repoRoot: config.repoRoot,
          runtimeSpecs,
          dataset: loaded?.dataset || null,
          fundingRates: loaded?.fundingRates || [],
          macroData: loaded?.macroData || null,
          symbol,
          timeframe,
        });
        sendJson(res, 200, {
          ok: true,
          symbol,
          timeframe,
          source: loaded?.source || 'local-fallback',
          radar,
          telemetry,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/frontier') {
        const tier = parsed.searchParams.get('tier') || config.riskTier || 'SAFE_75WR';
        const profile = (parsed.searchParams.get('profile') || 'EXCHANGE_POST_ONLY').toUpperCase();
        const version = (parsed.searchParams.get('version') || 'auto').toLowerCase();
        const frontier = runFrontierPortfolio({
          version,
          runtimeSpecs,
          config,
          riskTier: tier,
          execProfile: profile,
        });
        sendJson(res, 200, { ok: true, ...frontier });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/candles') {
        let candles = store.getCandles({ exchange, symbol, timeframe, limit });
        let overlay = daemon?.latestSnapshots?.get(`${symbol}:${timeframe}`)?.activeOverlay ||
          store.loadPaperState(`${exchange}:${symbol}:${timeframe}`)?.state?.activeOverlay ||
          null;
        let regime = daemon?.latestSnapshots?.get(`${symbol}:${timeframe}`)?.regime ||
          store.loadPaperState(`${exchange}:${symbol}:${timeframe}`)?.state?.regime ||
          null;
        let source = 'sqlite';

        if (candles.length === 0) {
          const loaded = loadOfflineOrDbDataset({ store, config, symbol, timeframe, minBars: 50 });
          candles = loaded.dataset.rows.slice(-limit);
          source = loaded.source;
          if (!overlay || !regime) {
            const evalRes = evaluateStrategy({
              dataset: loaded.dataset,
              fundingRates: loaded.fundingRates,
              macroData: loaded.macroData,
              timeframe,
              symbol,
              exchange,
              config,
              runtimeSpecs,
            });
            overlay = overlay || evalRes.activeOverlay;
            regime = regime || evalRes.regime;
          }
        }
        sendJson(res, 200, { ok: true, symbol, timeframe, source, count: candles.length, candles, overlay, regime });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/trades') {
        let trades = store.getTradesHistory({ exchange, symbol, timeframe, limit });
        let summary = store.loadPaperState(`${exchange}:${symbol}:${timeframe}`)?.state?.summary || null;
        if (trades.length === 0) {
          const loaded = loadOfflineOrDbDataset({ store, config, symbol, timeframe, minBars: 50 });
          const evalRes = evaluateStrategy({
            dataset: loaded.dataset,
            fundingRates: loaded.fundingRates,
            macroData: loaded.macroData,
            timeframe,
            symbol,
            exchange,
            config,
            runtimeSpecs,
          });
          trades = evalRes.trades.slice(-limit).reverse();
          summary = evalRes.summary;
        }
        sendJson(res, 200, { ok: true, symbol, timeframe, count: trades.length, summary, trades });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/signals') {
        let signals = store.getSignalsAudit({ exchange, symbol, timeframe, limit });
        if (signals.length === 0) {
          const loaded = loadOfflineOrDbDataset({ store, config, symbol, timeframe, minBars: 50 });
          const evalRes = evaluateStrategy({
            dataset: loaded.dataset,
            fundingRates: loaded.fundingRates,
            macroData: loaded.macroData,
            timeframe,
            symbol,
            exchange,
            config,
            runtimeSpecs,
          });
          signals = evalRes.signalsAudit.slice(-limit).reverse();
        }
        sendJson(res, 200, { ok: true, symbol, timeframe, count: signals.length, signals });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/backtest') {
        const defaultProf = isEq ? 'EQUITY_ETF' : 'EXCHANGE_POST_ONLY';
        const profile = (parsed.searchParams.get('profile') || defaultProf).toUpperCase();
        const mlEnabled = parsed.searchParams.get('ml') !== '0';
        const version = (parsed.searchParams.get('version') || 'auto').toLowerCase();
        const tier = parsed.searchParams.get('tier') || config.riskTier || 'SAFE_75WR';
        const loaded = loadOfflineOrDbDataset({ store, config, symbol, timeframe, minBars: 220 });
        const evalRes = evaluateStrategy({
          dataset: loaded.dataset,
          fundingRates: loaded.fundingRates,
          macroData: loaded.macroData,
          timeframe,
          symbol,
          exchange,
          execProfile: profile,
          mlEnabled,
          version,
          riskTier: tier,
          config,
          runtimeSpecs,
        });
        sendJson(res, 200, {
          ok: true,
          source: loaded.source,
          summary: evalRes.summary,
          regime: evalRes.regime,
          liquidationDistance: evalRes.liquidationDistance,
          monthlySummary: evalRes.monthlySummary,
          execOptions: evalRes.execOptions,
          equityCurve: evalRes.equityCurve.slice(-300),
          recentTrades: evalRes.trades.slice(-40).reverse(),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/mode') {
        const fetchSite = req.headers['sec-fetch-site'];
        if (fetchSite && !['same-origin', 'none'].includes(String(fetchSite))) {
          sendError(res, 403, 'Cross-site mode mutation rejected');
          return;
        }
        const body = await readJsonBody(req);
        const targetMode = String(body.executionMode || config.executionMode || 'PAPER').trim().toUpperCase();
        const targetDryRun = body.dryRun !== undefined ? Boolean(body.dryRun) : targetMode !== 'LIVE_ARMED';
        const targetTier = body.riskTier !== undefined ? normalizeRiskTier(body.riskTier) : config.riskTier;

        if (!['PAPER', 'LIVE_ARMED'].includes(targetMode)) {
          sendError(res, 400, 'executionMode must be PAPER or LIVE_ARMED');
          return;
        }

        if (targetMode === 'LIVE_ARMED' || targetDryRun === false) {
          if (!config.liveConfirmToken) {
            sendError(res, 403, 'LIVE_CONFIRM_TOKEN is not configured in server environment');
            return;
          }
          if (!timingSafeTokenEqual(config.liveConfirmToken, body.confirmToken)) {
            sendError(res, 403, 'Invalid LIVE_CONFIRM_TOKEN');
            return;
          }
          if (!hasExchangeCredentials(config, config.exchange)) {
            sendError(res, 403, `Exchange API credentials missing for ${config.exchange}`);
            return;
          }
        }

        config.executionMode = targetMode;
        config.dryRun = targetMode === 'PAPER' ? true : targetDryRun;
        config.riskTier = targetTier;
        sendJson(res, 200, {
          ok: true,
          config: redactConfig(config),
        });
        return;
      }

      if (req.method === 'GET') {
        serveStaticFile(res, pathname);
        return;
      }

      sendError(res, 404, 'Endpoint not found');
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  return {
    server,
    host,
    port,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve({ host: addr.address, port: addr.port });
        });
      });
    },
    stop() {
      return new Promise(resolve => {
        server.close(() => resolve());
      });
    },
  };
}
