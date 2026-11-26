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
  scrubSecrets,
  timingSafeTokenEqual,
} from './config.mjs';
import { CommercialPlatformEngine } from './commercial_engine.mjs';
import { CommercialStore } from './commercial_store.mjs';
import { AutopilotScheduler } from './autopilot-scheduler.mjs';
import {
  COMMERCIAL_PLANS,
  issueLicenseKey,
  resolveLicenseSigningSecret,
} from './license_issuer.mjs';
import {
  computeLiquidationDistance,
  computeRegimeTelemetry,
  computeV8MacroRegimeRadar,
  createExchangeClient,
  evaluateStrategy,
  getAllVersionsMatrixPreview,
  loadOfflineOrDbDataset,
  normalizeAssetSymbol,
  runFrontierPortfolio,
} from './engine_runtime.mjs';
import { isEquitySymbol } from './market_equities.mjs';
import {
  OKX_KEY_REQUIREMENTS_GUIDE,
  resolveRouterMode,
} from './order_router.mjs';

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

function buildFriendlyErrorPayload(message) {
  const safeMsg = String(message || 'Unknown error');
  const lower = safeMsg.toLowerCase();
  let userMessage = 'Da xay ra loi khi xu ly yeu cau.';
  let recoveryHint = 'Vui long kiem tra lai thong tin nhap va thu lai.';

  if (lower.includes('withdraw')) {
    userMessage = 'API Key co bat quyen Rut tien (Withdraw) nen da bi chan de bao ve tai san.';
    recoveryHint = 'Vao cai dat API tren san, tat quyen Withdraw (chi giu Read va Trade) roi kiem tra lai.';
  } else if (lower.includes('armingpin') || lower.includes('invalid armingpin')) {
    userMessage = 'Ma PIN bao ve khong dung hoac chua du 4 den 8 ky tu.';
    recoveryHint = 'Nhap dung ma PIN da tao khi ket noi tai khoan hoac tao lai ho so moi neu quen PIN.';
  } else if (lower.includes('sessiontoken') || lower.includes('unauthorized')) {
    userMessage = 'Phien dang nhap da het han hoac da bi khoa.';
    recoveryHint = 'Chon tai khoan da luu va nhap ma PIN de mo khoa lai phien lam viec.';
  } else if (lower.includes('commercial_master_key')) {
    userMessage = 'Che do Live can khoa bao mat he thong (COMMERCIAL_MASTER_KEY >= 32 ky tu).';
    recoveryHint = 'Hay dung che do Demo/Paper Sandbox hoac cau hinh COMMERCIAL_MASTER_KEY trong file .env.';
  } else if (lower.includes('license')) {
    userMessage = 'Ma ban quyen (License TT10) khong hop le hoac da het han.';
    recoveryHint = 'Bat tuy chon cap ban quyen cuc bo hoac kiem tra lai chuoi ma TT10 cua ban.';
  } else if (lower.includes('cross-site')) {
    userMessage = 'Yeu cau bi tu choi boi lop bao ve chong gia mao CSRF.';
    recoveryHint = 'Hay thao tac truc tiep tu giao dien web cuc bo tren may nay.';
  } else if (lower.includes('not found') || lower.includes('unknown subscriber')) {
    userMessage = 'Khong tim thay tai nguyen hoac ho so duoc yeu cau.';
    recoveryHint = 'Tai lai trang hoac chon mot ho so khac dang hoat dong.';
  } else if (lower.includes('passphrase') || lower.includes('credentials') || lower.includes('api')) {
    userMessage = 'Thong tin ket noi API san chua day du hoac khong hop le.';
    recoveryHint = 'Kiem tra lai API Key, API Secret va Passphrase (bat buoc voi OKX).';
  }

  return { ok: false, error: safeMsg, userMessage, recoveryHint };
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, buildFriendlyErrorPayload(message));
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
  const realPublic = fs.realpathSync(PUBLIC_DIR);
  const realTarget = fs.realpathSync(resolved);
  if (realTarget !== path.join(realPublic, 'index.html') && !realTarget.startsWith(realPublic + path.sep)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  const ext = path.extname(realTarget).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(realTarget).pipe(res);
}

export function createStandaloneServer({
  config,
  store,
  runtimeSpecs,
  daemon,
  checkAccountHealth = false,
  exchangeClientFactory = null,
} = {}) {
  const host = assertLoopbackHost(config.host || '127.0.0.1');
  const port = Number(config.port ?? 4180);
  const commercialStore = new CommercialStore(store);
  const commercialEngine = new CommercialPlatformEngine({
    store,
    commercialStore,
    config,
    runtimeSpecs,
    exchangeClientFactory,
  });
  const autopilotScheduler = new AutopilotScheduler({
    config,
    store,
    commercialStore,
    commercialEngine,
    daemon,
  });

  function scrubRequestSecrets(message, body = null) {
    let out = scrubSecrets(message, config);
    if (body && typeof body === 'object') {
      for (const field of ['apiKey', 'apiSecret', 'passphrase', 'armingPin', 'sessionToken', 'licenseKey']) {
        const val = body[field];
        if (typeof val === 'string' && val.length >= 4) {
          out = out.split(val).join('[REDACTED]');
        }
      }
    }
    return out;
  }

  function checkCsrfPost(req, res) {
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && !['same-origin', 'none'].includes(String(fetchSite))) {
      sendError(res, 403, 'Cross-site mutation rejected');
      return false;
    }
    const originHeader = req.headers.origin;
    if (originHeader) {
      try {
        const originUrl = new URL(String(originHeader));
        const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
        if (!allowedHosts.has(originUrl.hostname)) {
          sendError(res, 403, 'Cross-origin mutation rejected');
          return false;
        }
      } catch {
        sendError(res, 403, 'Cross-origin mutation rejected');
        return false;
      }
    }
    return true;
  }

  function assertAdminAuthorized(req, res, providedToken) {
    if (!config.commercialAdminToken) {
      sendError(res, 403, 'COMMERCIAL_ADMIN_TOKEN is not configured');
      return false;
    }
    if (!timingSafeTokenEqual(config.commercialAdminToken, providedToken)) {
      sendError(res, 403, 'Invalid COMMERCIAL_ADMIN_TOKEN');
      return false;
    }
    return true;
  }

  function authenticateSubOr401(req, res, body = {}, parsed = null) {
    const sessionToken = req.headers['x-subscriber-token']
      || parsed?.searchParams?.get('subscriberToken')
      || body?.sessionToken
      || '';
    let sub = null;
    try {
      sub = commercialEngine.authenticateSubscriber({
        sessionToken: String(sessionToken || ''),
      });
    } catch (err) {
      sendError(res, 401, scrubSecrets(err.message, config));
      return null;
    }
    if (body?.subscriberId && sub.subscriberId !== body.subscriberId) {
      sendError(res, 403, 'SECURITY BLOCK: Cross-tenant subscriberId mismatch');
      return null;
    }
    return sub;
  }

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
      if (req.method === 'POST' && !checkCsrfPost(req, res)) {
        return;
      }
      const parsed = new URL(req.url || '/', `http://${host}:${port}`);
      const pathname = parsed.pathname;
      const symbol = normalizeAssetSymbol(parsed.searchParams.get('symbol') || config.symbols[0] || 'BTCUSDT.P');
      const isEq = isEquitySymbol(symbol);
      const exchange = isEq ? 'YAHOO' : config.exchange;
      const defaultTf = isEq ? '1d' : (config.timeframes[0] || '1h');
      const timeframe = (parsed.searchParams.get('timeframe') || defaultTf).toLowerCase();
      const rawLim = Number(parsed.searchParams.get('limit'));
      const limit = Math.min(2000, Math.max(10, Number.isFinite(rawLim) ? Math.trunc(rawLim) : 240));

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
          store,
          exchange,
        });
        let v8Radar = regime?.v8Radar || null;
        if (!v8Radar && runtimeSpecs?.hasV8RegimeEngine) {
          try {
            v8Radar = computeV8MacroRegimeRadar({
              repoRoot: config.repoRoot,
              runtimeSpecs,
              symbol,
              timeframe,
              store,
              exchange,
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
            v9EngineReady: Boolean(runtimeSpecs?.hasV9Engine),
            v9ModelsReady: Boolean(runtimeSpecs?.hasV9Models),
            v9FrontierReady: Boolean(runtimeSpecs?.hasV9Frontier),
            allVersionsMatrixReady: Boolean(runtimeSpecs?.hasAllVersionsMatrix),
            v10CommercialReady: true,
            v11AutopilotReady: true,
            activeModelVersion: summary?.modelVersion || (runtimeSpecs?.hasV9Models ? 'v9.0-Ensemble' : runtimeSpecs?.hasV8Models ? 'v8.0-RegimeMax' : runtimeSpecs?.hasV7Models ? 'v7.0-HighWR' : runtimeSpecs?.hasV5Ml ? 'v5.0-ML' : 'v4.1-fallback'),
          },
          routerStatus: daemon?.orderRouter ? daemon.orderRouter.getStatus() : {
            ...resolveRouterMode(config),
            maxLeverageCap: Number(config.maxLeverageCap ?? 3.0),
            maxOrderUsdt: Number(config.maxOrderUsdt ?? 500),
            okxKeyGuide: OKX_KEY_REQUIREMENTS_GUIDE,
          },
          daemon: {
            lastSyncAt: daemon?.lastSyncAt || null,
            lastEvalAt: daemon?.lastEvalAt || null,
            lastError: daemon?.lastError || null,
            lastRouteResult: daemon?.lastRouteResult || null,
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

      if (req.method === 'GET' && pathname === '/api/versions') {
        const preview = await getAllVersionsMatrixPreview({ repoRoot: config.repoRoot, runtimeSpecs });
        sendJson(res, 200, { ok: true, ...preview });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/orders') {
        const filterSym = parsed.searchParams.get('symbol');
        const normalizedSym = filterSym ? normalizeAssetSymbol(filterSym) : undefined;
        const orders = store.getOrdersLog({ symbol: normalizedSym, limit });
        const router = daemon?.orderRouter
          ? daemon.orderRouter.getStatus()
          : {
              ...resolveRouterMode(config),
              maxLeverageCap: Number(config.maxLeverageCap ?? 3.0),
              maxOrderUsdt: Number(config.maxOrderUsdt ?? 500),
            };
        sendJson(res, 200, {
          ok: true,
          router,
          okxKeyGuide: OKX_KEY_REQUIREMENTS_GUIDE,
          count: orders.length,
          orders,
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
          store,
          exchange,
        });
        const telemetry = computeRegimeTelemetry({
          repoRoot: config.repoRoot,
          runtimeSpecs,
          dataset: loaded?.dataset || null,
          fundingRates: loaded?.fundingRates || [],
          macroData: loaded?.macroData || null,
          symbol,
          timeframe,
          store,
          exchange,
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
              store,
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
            store,
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
            store,
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
          store,
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
        if (daemon?.cryptoClient) {
          daemon.cryptoClient.executionMode = config.executionMode;
          daemon.cryptoClient.dryRun = config.dryRun;
        }
        sendJson(res, 200, {
          ok: true,
          config: redactConfig(config),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/commercial/plans') {
        sendJson(res, 200, {
          ok: true,
          plans: COMMERCIAL_PLANS,
          guardrails: [
            '1. Valid non-expired TT10 license & execution mode permitted by plan',
            '2. Exchange API key must NEVER have Withdraw permission enabled',
            '3. Valid subscriber arming PIN required for DEMO_AUTO_TRADE / LIVE_AUTO_TRADE',
            '4. Daily Loss Circuit Breaker trips auto-trade on breach',
            '5. High-Water MaxDD Kill Switch halts auto-trade permanently until reset',
            '6. Account equity <= plan maxCapitalUsdt & leverage <= maxLeverageCap',
            '7. Contract sizing rounded to exchange lotSz/stepSize + idempotent tenant clOrdId',
          ],
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/commercial/simulate-scan') {
        const body = await readJsonBody(req);
        const sim = await commercialEngine.simulateCapitalPreview({
          equityUsdt: body.equityUsdt ?? 1000,
          exchange: body.exchange || config.exchange || 'OKX',
          version: body.version || 'v9',
          riskTier: body.riskTier || config.riskTier || 'SAFE_75WR',
          riskPct: body.riskPct ?? 1.0,
        });
        sendJson(res, 200, { ok: true, ...sim });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/commercial/admin/licenses') {
        const body = await readJsonBody(req);
        const adminToken = req.headers['x-admin-token'] || body.adminToken || '';
        if (!assertAdminAuthorized(req, res, String(adminToken))) return;
        const issued = issueLicenseKey({
          planId: body.planId || 'PRO_AUTO_TRADER',
          subscriberRef: body.subscriberRef || 'buyer@example.com',
          durationDays: Number(body.durationDays ?? 30),
          maxCapitalUsdtOverride: body.maxCapitalUsdtOverride ?? null,
          signingSecret: resolveLicenseSigningSecret(config),
        });
        sendJson(res, 200, { ok: true, ...issued });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/commercial/admin/overview') {
        const adminToken = req.headers['x-admin-token'] || parsed.searchParams.get('adminToken') || '';
        if (!assertAdminAuthorized(req, res, String(adminToken))) return;
        sendJson(res, 200, { ok: true, ...commercialEngine.getAdminOverview() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/commercial/subscribers/onboard') {
        const body = await readJsonBody(req);
        try {
          const onboarded = await commercialEngine.onboardSubscriber({
            name: body.name,
            email: body.email ?? null,
            licenseKey: body.licenseKey,
            exchange: body.exchange || config.exchange || 'OKX',
            simulated: body.simulated !== undefined ? Boolean(body.simulated) : true,
            apiKey: body.apiKey || '',
            apiSecret: body.apiSecret || '',
            passphrase: body.passphrase || '',
            rawPermissionPayload: body.rawPermissionPayload ?? null,
            armingPin: body.armingPin || '',
            executionMode: body.executionMode || 'SCAN_AND_SIGNAL_ONLY',
            preferredVersion: body.preferredVersion || 'v9',
            riskTier: body.riskTier || config.riskTier || 'SAFE_75WR',
            riskPct: body.riskPct ?? 1.0,
            maxLeverageCap: body.maxLeverageCap ?? config.maxLeverageCap ?? 3.0,
            maxDailyLossPct: body.maxDailyLossPct ?? 5.0,
            maxDdKillPct: body.maxDdKillPct ?? 20.0,
            simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
          });
          sendJson(res, 200, { ok: true, ...onboarded });
        } catch (err) {
          const safeMsg = scrubSecrets(err.message, config);
          const status = safeMsg.includes('SECURITY BLOCK') ? 403 : 400;
          sendError(res, status, safeMsg);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/commercial/subscribers/scan') {
        const body = await readJsonBody(req);
        const sub = authenticateSubOr401(req, res, body, parsed);
        if (!sub) return;
        try {
          const scanRes = await commercialEngine.scanSubscriberAccount(sub.subscriberId, {
            simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
            availableMarginUsdt: body.availableMarginUsdt ?? null,
            timeframe: body.timeframe || '1h',
          });
          sendJson(res, 200, { ok: true, ...scanRes });
        } catch (err) {
          const safeMsg = scrubRequestSecrets(err.message, body);
          const isForbidden = safeMsg.includes('SECURITY BLOCK') || safeMsg.includes('WITHDRAW');
          sendError(res, isForbidden ? 403 : 400, safeMsg);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/commercial/subscribers/mode') {
        const body = await readJsonBody(req);
        const sub = authenticateSubOr401(req, res, body, parsed);
        if (!sub) return;
        try {
          const updated = commercialEngine.updateSubscriberMode(sub.subscriberId, {
            executionMode: body.executionMode,
            armingPin: body.armingPin || '',
            maxDailyLossPct: body.maxDailyLossPct,
            maxDdKillPct: body.maxDdKillPct,
            preferredVersion: body.preferredVersion,
            riskTier: body.riskTier,
            riskPct: body.riskPct,
            maxLeverageCap: body.maxLeverageCap,
            resetTrips: Boolean(body.resetTrips),
          });
          sendJson(res, 200, { ok: true, subscriber: updated });
        } catch (err) {
          const safeMsg = scrubRequestSecrets(err.message, body);
          sendError(res, 403, safeMsg);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/commercial/subscribers/run-cycle') {
        const body = await readJsonBody(req);
        const sub = authenticateSubOr401(req, res, body, parsed);
        if (!sub) return;
        try {
          const cycleRes = await commercialEngine.runSubscriberAutoTradeCycle(sub.subscriberId, {
            armingPin: body.armingPin || '',
            simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
            availableMarginUsdt: body.availableMarginUsdt ?? null,
            timeframe: body.timeframe || '1h',
          });
          sendJson(res, 200, { ok: true, ...cycleRes });
        } catch (err) {
          const safeMsg = scrubRequestSecrets(err.message, body);
          const isForbidden = safeMsg.includes('SECURITY BLOCK')
            || safeMsg.includes('armingPin')
            || safeMsg.includes('Kill')
            || safeMsg.includes('Circuit');
          sendError(res, isForbidden ? 403 : 400, safeMsg);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/commercial/subscribers/dashboard') {
        const sub = authenticateSubOr401(req, res, {}, parsed);
        if (!sub) return;
        const dash = commercialEngine.getSubscriberDashboard(sub.subscriberId);
        sendJson(res, 200, { ok: true, ...dash });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/autopilot/status') {
        const rawToken = req.headers['x-subscriber-token'] || parsed.searchParams.get('subscriberToken') || '';
        let subId = null;
        if (rawToken) {
          const sub = authenticateSubOr401(req, res, {}, parsed);
          if (!sub) return;
          subId = sub.subscriberId;
        }
        const status = autopilotScheduler.getStatus({
          subscriberId: subId,
          includeLocalProfiles: true,
        });
        sendJson(res, 200, { ok: true, ...status });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/quickstart-license') {
        if (!config.localQuickstartEnabled) {
          sendError(res, 403, 'Local quickstart license bootstrap is disabled (LOCAL_QUICKSTART_ENABLED=false)');
          return;
        }
        const body = await readJsonBody(req);
        const issued = issueLicenseKey({
          planId: body.planId || 'PRO_AUTO_TRADER',
          subscriberRef: body.subscriberRef || 'local@localhost',
          durationDays: Number(body.durationDays ?? 365),
          maxCapitalUsdtOverride: body.maxCapitalUsdtOverride ?? null,
          signingSecret: resolveLicenseSigningSecret(config),
        });
        sendJson(res, 200, { ok: true, ...issued });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/verify-connection') {
        const body = await readJsonBody(req);
        const rawToken = req.headers['x-subscriber-token'] || parsed?.searchParams?.get('subscriberToken') || body?.sessionToken || '';
        let subId = null;
        if (rawToken || body.subscriberId) {
          const sub = authenticateSubOr401(req, res, body, parsed);
          if (!sub) return;
          subId = sub.subscriberId;
        }
        try {
          const probe = await commercialEngine.probeExchangeConnection({
            subscriberId: subId,
            exchange: body.exchange || undefined,
            simulated: body.simulated,
            apiKey: body.apiKey || '',
            apiSecret: body.apiSecret || '',
            passphrase: body.passphrase || '',
            rawPermissionPayload: body.rawPermissionPayload ?? null,
            simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
            timeframe: body.timeframe || '1h',
          });
          sendJson(res, 200, { ok: true, ...probe });
        } catch (err) {
          const safeMsg = scrubRequestSecrets(err.message, body);
          const status = (safeMsg.includes('SECURITY BLOCK') || safeMsg.includes('WITHDRAW')) ? 403 : 400;
          sendError(res, status, safeMsg);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/demo-sandbox') {
        if (!config.localQuickstartEnabled) {
          sendError(res, 403, 'Demo sandbox quickstart is disabled when LOCAL_QUICKSTART_ENABLED=false');
          return;
        }
        const body = await readJsonBody(req);
        try {
          const sandbox = await commercialEngine.startOrReusePaperSandbox({
            exchange: body.exchange || config.exchange || 'OKX',
            preferredVersion: body.preferredVersion || 'v9',
            riskTier: body.riskTier || config.riskTier || 'SAFE_75WR',
            riskPct: body.riskPct ?? 1.0,
            maxLeverageCap: body.maxLeverageCap ?? config.maxLeverageCap ?? 3.0,
            maxDailyLossPct: body.maxDailyLossPct ?? 5.0,
            maxDdKillPct: body.maxDdKillPct ?? 20.0,
            simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
            timeframe: body.timeframe || '1h',
          });

          const autopilot = await autopilotScheduler.armSubscriber({
            subscriberId: sandbox.subscriber.subscriberId,
            armingPin: body.armingPin || '',
            executionMode: 'PAPER_AUTO_TRADE',
            timeframe: body.timeframe || '1h',
            intervalSec: body.intervalSec ?? config.autopilotIntervalSec,
            simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
            runImmediately: body.runImmediately !== false,
          });

          const status = autopilotScheduler.getStatus({
            subscriberId: sandbox.subscriber.subscriberId,
            includeLocalProfiles: Boolean(config.localQuickstartEnabled || sandbox.subscriber.subscriberId),
          });
          sendJson(res, 200, { ok: true, ...sandbox, autopilot, status });
        } catch (err) {
          sendError(res, 400, scrubRequestSecrets(err.message, body));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/connect-and-start') {
        const body = await readJsonBody(req);
        const rawToken = req.headers['x-subscriber-token'] || parsed?.searchParams?.get('subscriberToken') || body?.sessionToken || '';
        let authSubId = null;
        if (rawToken) {
          const sub = authenticateSubOr401(req, res, body, parsed);
          if (!sub) return;
          authSubId = sub.subscriberId;
        }
        try {
          let licenseKey = String(body.licenseKey || '').trim();
          if (!licenseKey) {
            if (!config.localQuickstartEnabled) {
              sendError(res, 403, 'Local quickstart is disabled; valid TT10 licenseKey is required');
              return;
            }
            licenseKey = issueLicenseKey({
              planId: body.planId || 'PRO_AUTO_TRADER',
              subscriberRef: body.email || body.name || 'local@localhost',
              durationDays: 365,
              signingSecret: resolveLicenseSigningSecret(config),
            }).licenseKey;
          }

          const autoStart = body.autoStart !== false;
          const isSimulated = body.simulated !== undefined ? Boolean(body.simulated) : true;
          const executionMode = body.executionMode
            ? String(body.executionMode).trim().toUpperCase()
            : (autoStart ? (isSimulated ? 'DEMO_AUTO_TRADE' : 'LIVE_AUTO_TRADE') : 'SCAN_AND_SIGNAL_ONLY');

          const onboarded = await commercialEngine.connectOrUpgradeSubscriber({
            subscriberId: body.subscriberId || authSubId || null,
            authenticatedSubscriberId: authSubId,
            name: body.name || 'Local Autopilot Trader',
            email: body.email ?? null,
            licenseKey,
            exchange: body.exchange || config.exchange || 'OKX',
            simulated: isSimulated,
            apiKey: body.apiKey || '',
            apiSecret: body.apiSecret || '',
            passphrase: body.passphrase || '',
            rawPermissionPayload: body.rawPermissionPayload ?? null,
            armingPin: body.armingPin || '',
            executionMode,
            preferredVersion: body.preferredVersion || 'v9',
            riskTier: body.riskTier || config.riskTier || 'SAFE_75WR',
            riskPct: body.riskPct ?? 1.0,
            maxLeverageCap: body.maxLeverageCap ?? config.maxLeverageCap ?? 3.0,
            maxDailyLossPct: body.maxDailyLossPct ?? 5.0,
            maxDdKillPct: body.maxDdKillPct ?? 20.0,
            isPaperSandbox: executionMode === 'PAPER_AUTO_TRADE',
            simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
          });

          let autopilot = null;
          if (autoStart) {
            autopilot = await autopilotScheduler.armSubscriber({
              subscriberId: onboarded.subscriber.subscriberId,
              armingPin: body.armingPin || '',
              executionMode,
              timeframe: body.timeframe || '1h',
              intervalSec: body.intervalSec ?? config.autopilotIntervalSec,
              simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
              runImmediately: body.runImmediately !== false,
            });
          }

          const status = autopilotScheduler.getStatus({
            subscriberId: onboarded.subscriber.subscriberId,
            includeLocalProfiles: Boolean(config.localQuickstartEnabled || onboarded.subscriber.subscriberId),
          });
          sendJson(res, 200, { ok: true, ...onboarded, autopilot, status });
        } catch (err) {
          const safeMsg = scrubRequestSecrets(err.message, body);
          const isForbidden = safeMsg.includes('SECURITY BLOCK')
            || safeMsg.includes('WITHDRAW')
            || safeMsg.includes('Invalid armingPin')
            || safeMsg.includes('COMMERCIAL_MASTER_KEY')
            || safeMsg.includes('already bound')
            || safeMsg.includes('Unauthorized');
          sendError(res, isForbidden ? 403 : 400, safeMsg);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/settings') {
        const body = await readJsonBody(req);
        const sub = authenticateSubOr401(req, res, body, parsed);
        if (!sub) return;
        try {
          const updated = await commercialEngine.updateSubscriberSettingsAndCreds(sub.subscriberId, {
            name: body.name,
            email: body.email,
            exchange: body.exchange,
            simulated: body.simulated,
            preferredVersion: body.preferredVersion,
            riskTier: body.riskTier,
            riskPct: body.riskPct,
            maxLeverageCap: body.maxLeverageCap,
            maxDailyLossPct: body.maxDailyLossPct,
            maxDdKillPct: body.maxDdKillPct,
            planId: body.planId,
            licenseKey: body.licenseKey,
            armingPin: body.armingPin,
            apiKey: body.apiKey || '',
            apiSecret: body.apiSecret || '',
            passphrase: body.passphrase || '',
            rawPermissionPayload: body.rawPermissionPayload ?? null,
            executionMode: body.executionMode,
          });
          if (body.intervalSec !== undefined || body.timeframe !== undefined) {
            autopilotScheduler.updateLeaseSchedule(sub.subscriberId, {
              intervalSec: body.intervalSec,
              timeframe: body.timeframe,
            });
          }
          const status = autopilotScheduler.getStatus({
            subscriberId: sub.subscriberId,
            includeLocalProfiles: Boolean(config.localQuickstartEnabled || sub.subscriberId),
          });
          sendJson(res, 200, { ok: true, subscriber: updated, status });
        } catch (err) {
          const safeMsg = scrubRequestSecrets(err.message, body);
          const isForbidden = safeMsg.includes('SECURITY BLOCK')
            || safeMsg.includes('WITHDRAW')
            || safeMsg.includes('COMMERCIAL_MASTER_KEY')
            || safeMsg.includes('TT10 licenseKey is required');
          sendError(res, isForbidden ? 403 : 400, safeMsg);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/delete-profile') {
        const body = await readJsonBody(req);
        const rawToken = req.headers['x-subscriber-token'] || parsed?.searchParams?.get('subscriberToken') || body?.sessionToken || '';
        const adminToken = req.headers['x-admin-token'] || body?.adminToken || '';
        let targetId = body.subscriberId || null;
        let authorized = false;

        if (rawToken) {
          const sub = authenticateSubOr401(req, res, body, parsed);
          if (!sub) return;
          if (!targetId) targetId = sub.subscriberId;
          if (sub.subscriberId !== targetId) {
            sendError(res, 403, 'SECURITY BLOCK: Cross-tenant subscriberId mismatch');
            return;
          }
          authorized = true;
        } else if (adminToken) {
          if (!assertAdminAuthorized(req, res, String(adminToken))) return;
          authorized = true;
        }

        if (!targetId) {
          sendError(res, 400, 'subscriberId is required to delete profile');
          return;
        }
        const existing = commercialStore.getSubscriberById(targetId);
        if (!existing) {
          sendError(res, 404, `Unknown subscriber: ${targetId}`);
          return;
        }

        if (!authorized) {
          if (typeof body.armingPin === 'string' && body.armingPin.length > 0) {
            if (typeof commercialEngine.verifySubscriberPin === 'function' && commercialEngine.verifySubscriberPin(targetId, body.armingPin)) {
              authorized = true;
            } else {
              sendError(res, 403, 'SECURITY BLOCK: Invalid armingPin for delete-profile');
              return;
            }
          } else if (Boolean(existing.is_paper_sandbox) && !existing.arming_pin_hash && Boolean(config.localQuickstartEnabled)) {
            authorized = true;
          } else {
            sendError(res, 401, 'Authentication (subscriber token, admin token, or armingPin) is required to delete profile');
            return;
          }
        }

        await autopilotScheduler.disarmSubscriber(targetId, {
          reason: 'PROFILE_DELETED',
          cancelPendingEntries: Boolean(body.cancelPendingEntries),
        });
        const deleted = commercialStore.deleteSubscriberCascade(targetId);
        const status = autopilotScheduler.getStatus({
          subscriberId: null,
          includeLocalProfiles: Boolean(config.localQuickstartEnabled),
        });
        sendJson(res, 200, { ok: true, ...deleted, status });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/commercial/subscribers/unlock') {
        const body = await readJsonBody(req);
        try {
          const unlocked = commercialEngine.unlockSubscriberSession({
            subscriberId: body.subscriberId,
            armingPin: body.armingPin || '',
          });
          const status = autopilotScheduler.getStatus({
            subscriberId: unlocked.subscriber.subscriberId,
            includeLocalProfiles: true,
          });
          sendJson(res, 200, { ok: true, ...unlocked, status });
        } catch (err) {
          sendError(res, 403, scrubRequestSecrets(err.message, body));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/start') {
        const body = await readJsonBody(req);
        const sub = authenticateSubOr401(req, res, body, parsed);
        if (!sub) return;
        try {
          let targetMode = body.executionMode ? String(body.executionMode).trim().toUpperCase() : null;
          if (!targetMode && sub.executionMode === 'SCAN_AND_SIGNAL_ONLY') {
            targetMode = sub.isPaperSandbox ? 'PAPER_AUTO_TRADE' : (sub.simulated ? 'DEMO_AUTO_TRADE' : 'LIVE_AUTO_TRADE');
          }
          const isZeroPinSandbox = Boolean(sub.isPaperSandbox) && !sub.hasArmingPin && (!targetMode || targetMode === 'PAPER_AUTO_TRADE');
          if (!isZeroPinSandbox && (!body.armingPin || typeof body.armingPin !== 'string')) {
            sendError(res, 403, 'SECURITY BLOCK: armingPin is required to start Autopilot');
            return;
          }
          const armed = await autopilotScheduler.armSubscriber({
            subscriberId: sub.subscriberId,
            armingPin: body.armingPin || '',
            executionMode: targetMode,
            timeframe: body.timeframe || '1h',
            intervalSec: body.intervalSec ?? config.autopilotIntervalSec,
            simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
            runImmediately: body.runImmediately !== false,
          });
          const status = autopilotScheduler.getStatus({
            subscriberId: sub.subscriberId,
            includeLocalProfiles: Boolean(config.localQuickstartEnabled || sub.subscriberId),
          });
          sendJson(res, 200, { ok: true, ...armed, status });
        } catch (err) {
          const safeMsg = scrubRequestSecrets(err.message, body);
          const isForbidden = safeMsg.includes('SECURITY BLOCK')
            || safeMsg.includes('WITHDRAW')
            || safeMsg.includes('armingPin')
            || safeMsg.includes('COMMERCIAL_MASTER_KEY')
            || safeMsg.includes('License')
            || safeMsg.includes('does not allow');
          sendError(res, isForbidden ? 403 : 400, safeMsg);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/stop') {
        const body = await readJsonBody(req);
        const sub = authenticateSubOr401(req, res, body, parsed);
        if (!sub) return;
        const stopped = await autopilotScheduler.disarmSubscriber(sub.subscriberId, {
          reason: body.reason || 'MANUAL_PAUSE',
          cancelPendingEntries: Boolean(body.cancelPendingEntries),
        });
        const status = autopilotScheduler.getStatus({
          subscriberId: sub.subscriberId,
          includeLocalProfiles: Boolean(config.localQuickstartEnabled || sub.subscriberId),
        });
        sendJson(res, 200, { ok: true, ...stopped, status });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/autopilot/tick') {
        const body = await readJsonBody(req);
        const sub = authenticateSubOr401(req, res, body, parsed);
        if (!sub) return;
        const tick = await autopilotScheduler.tickSubscriber(sub.subscriberId, {
          simulatedEquityUsdt: body.simulatedEquityUsdt ?? null,
        });
        const status = autopilotScheduler.getStatus({
          subscriberId: sub.subscriberId,
          includeLocalProfiles: Boolean(config.localQuickstartEnabled || sub.subscriberId),
        });
        sendJson(res, 200, { ok: true, ...tick, status });
        return;
      }

      if (req.method === 'GET') {
        serveStaticFile(res, pathname);
        return;
      }

      sendError(res, 404, 'Endpoint not found');
    } catch (err) {
      sendError(res, 500, scrubSecrets(err.message, config));
    }
  });

  server.keepAliveTimeout = 60000;
  server.headersTimeout = 65000;

  return {
    server,
    host,
    port,
    autopilotScheduler,
    commercialEngine,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          autopilotScheduler.start();
          const addr = server.address();
          resolve({ host: addr.address, port: addr.port });
        });
      });
    },
    stop() {
      autopilotScheduler.stop();
      server.closeIdleConnections?.();
      return new Promise(resolve => {
        server.close(() => resolve());
      });
    },
  };
}
