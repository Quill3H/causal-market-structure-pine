import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const VALID_EXCHANGES = Object.freeze(['OKX', 'BINANCE', 'YAHOO']);
export const VALID_EXECUTION_MODES = Object.freeze(['PAPER', 'LIVE_ARMED']);
export const VALID_RISK_TIERS = Object.freeze(['SAFE_75WR', 'BALANCED_75WR', 'TARGET_30MO_75WR']);
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);

export const RISK_TIER_SPECS = Object.freeze({
  SAFE_75WR: {
    id: 'SAFE_75WR',
    frontierKey: 'TIER_1_SAFE_75WR',
    label: 'Safe (75%+ WR, Low DD)',
    targetMaxDdPct: 25,
    defaultLevScale: 1.0,
  },
  BALANCED_75WR: {
    id: 'BALANCED_75WR',
    frontierKey: 'TIER_2_BALANCED_75WR',
    label: 'Balanced (75%+ WR, Mod DD)',
    targetMaxDdPct: 35,
    defaultLevScale: 1.5,
  },
  TARGET_30MO_75WR: {
    id: 'TARGET_30MO_75WR',
    frontierKey: 'TIER_3_TARGET_30MO_75WR',
    label: '30%/Mo Frontier (Zero-Liq)',
    targetMaxDdPct: 55,
    defaultLevScale: 2.5,
  },
});

export function normalizeRiskTier(tier) {
  const raw = String(tier || 'SAFE_75WR').trim().toUpperCase();
  if (raw === 'TIER_1_SAFE_75WR' || raw === 'SAFE') return 'SAFE_75WR';
  if (raw === 'TIER_2_BALANCED_75WR' || raw === 'BALANCED') return 'BALANCED_75WR';
  if (raw === 'TIER_3_TARGET_30MO_75WR' || raw === '30MO' || raw === 'TARGET_30MO') return 'TARGET_30MO_75WR';
  if (!VALID_RISK_TIERS.includes(raw)) {
    throw new Error(`Invalid RISK_TIER "${tier}". Allowed: ${VALID_RISK_TIERS.join(', ')}`);
  }
  return raw;
}

export const ALL_V6_ASSETS = Object.freeze([
  { symbol: 'BTCUSDT.P', label: 'BTCUSDT.P (5Y Perp)', assetClass: 'CRYPTO', defaultTimeframe: '1h', supportedTimeframes: ['1h', '15m'] },
  { symbol: 'ETHUSDT.P', label: 'ETHUSDT.P (5Y Perp)', assetClass: 'CRYPTO', defaultTimeframe: '1h', supportedTimeframes: ['1h'] },
  { symbol: 'SOLUSDT.P', label: 'SOLUSDT.P (5Y Perp)', assetClass: 'CRYPTO', defaultTimeframe: '1h', supportedTimeframes: ['1h'] },
  { symbol: 'BNBUSDT.P', label: 'BNBUSDT.P (5Y Perp)', assetClass: 'CRYPTO', defaultTimeframe: '1h', supportedTimeframes: ['1h'] },
  { symbol: 'SPY', label: 'S&P 500 (SPY / ^GSPC)', assetClass: 'EQUITY_ETF', defaultTimeframe: '1d', supportedTimeframes: ['1d', '1h'] },
  { symbol: 'DIA', label: 'Dow Jones (DIA / ^DJI)', assetClass: 'EQUITY_ETF', defaultTimeframe: '1d', supportedTimeframes: ['1d', '1h'] },
  { symbol: 'QQQ', label: 'Nasdaq 100 (QQQ / ^NDX)', assetClass: 'EQUITY_ETF', defaultTimeframe: '1d', supportedTimeframes: ['1d', '1h'] },
]);

const SECRET_KEYS = Object.freeze([
  'OKX_API_KEY',
  'OKX_API_SECRET',
  'OKX_PASSPHRASE',
  'BINANCE_API_KEY',
  'BINANCE_API_SECRET',
  'ALPACA_API_KEY',
  'ALPACA_API_SECRET',
  'TWELVEDATA_API_KEY',
  'LIVE_CONFIRM_TOKEN',
  'COMMERCIAL_MASTER_KEY',
  'COMMERCIAL_LICENSE_SECRET',
  'COMMERCIAL_ADMIN_TOKEN',
]);

/**
 * Parses a .env file string cleanly without external dependencies.
 * Supports comments (#), optional `export ` prefix, and single/double quotes.
 */
export function parseDotEnv(content) {
  const out = {};
  if (typeof content !== 'string' || !content) return out;
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) {
      line = line.slice(7).trim();
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim();
      }
    }
    out[key] = val;
  }
  return out;
}

function parseBool(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const s = String(val).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

function parseNum(val, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseList(val, fallback) {
  if (val === undefined || val === null || String(val).trim() === '') return [...fallback];
  const items = String(val)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [...fallback];
}

export function isLoopbackHost(host) {
  const normalized = String(host ?? '').trim().toLowerCase();
  return LOOPBACK_HOSTS.includes(normalized);
}

export function assertLoopbackHost(host) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Security policy violation: HTTP server host "${host}" rejected. Only loopback hosts (${LOOPBACK_HOSTS.join(', ')}) are permitted.`,
    );
  }
  return String(host).trim();
}

export function timingSafeTokenEqual(a, b) {
  const s1 = String(a ?? '');
  const s2 = String(b ?? '');
  if (!s1 || !s2) return false;
  const buf1 = Buffer.from(s1, 'utf8');
  const buf2 = Buffer.from(s2, 'utf8');
  if (buf1.length !== buf2.length) return false;
  return crypto.timingSafeEqual(buf1, buf2);
}

/**
 * Loads standalone engine configuration from .env + process.env overrides.
 * Enforces hard safety defaults: PAPER mode, DRY_RUN=true, MAX_LEVERAGE_CAP<=3.0, loopback host.
 */
export function loadConfig({
  cwd = REPO_ROOT,
  envPath,
  envOverrides = {},
  useProcessEnv = true,
} = {}) {
  const resolvedEnvPath = envPath ? path.resolve(cwd, envPath) : path.join(cwd, '.env');
  let fileEnv = {};
  if (fs.existsSync(resolvedEnvPath)) {
    fileEnv = parseDotEnv(fs.readFileSync(resolvedEnvPath, 'utf8'));
  }

  const merged = {
    ...fileEnv,
    ...(useProcessEnv ? process.env : {}),
    ...envOverrides,
  };

  const rawExchange = String(merged.EXCHANGE || 'OKX').trim().toUpperCase();
  const exchange = VALID_EXCHANGES.includes(rawExchange) ? rawExchange : 'OKX';

  const rawMode = String(merged.EXECUTION_MODE || 'PAPER').trim().toUpperCase();
  if (!VALID_EXECUTION_MODES.includes(rawMode)) {
    throw new Error(`Invalid EXECUTION_MODE "${rawMode}". Allowed: ${VALID_EXECUTION_MODES.join(', ')}`);
  }

  const riskTier = normalizeRiskTier(merged.RISK_TIER || 'SAFE_75WR');

  const host = assertLoopbackHost(merged.HOST || '127.0.0.1');
  const port = Math.trunc(parseNum(merged.PORT, 4180, { min: 0, max: 65535 }));
  const dryRun = parseBool(merged.DRY_RUN, true);
  const maxLeverageCap = parseNum(merged.MAX_LEVERAGE_CAP, 3.0, { min: 0.5, max: 3.0 });
  const maxOrderUsdt = parseNum(merged.MAX_ORDER_USDT, 500, { min: 10, max: 100000 });

  const symbols = parseList(merged.SYMBOLS, ['BTCUSDT.P']);
  const timeframes = parseList(merged.TIMEFRAMES, ['1h', '15m']);

  const sqliteRaw = String(merged.SQLITE_PATH || 'data/standalone.sqlite').trim();
  const sqlitePath = path.isAbsolute(sqliteRaw) ? sqliteRaw : path.resolve(cwd, sqliteRaw);
  const allowedDataDir = path.resolve(cwd, 'data');

  const okx = {
    apiKey: String(merged.OKX_API_KEY || '').trim(),
    apiSecret: String(merged.OKX_API_SECRET || '').trim(),
    passphrase: String(merged.OKX_PASSPHRASE || '').trim(),
    simulated: parseBool(merged.OKX_SIMULATED, true),
  };

  const binance = {
    apiKey: String(merged.BINANCE_API_KEY || '').trim(),
    apiSecret: String(merged.BINANCE_API_SECRET || '').trim(),
    testnet: parseBool(merged.BINANCE_TESTNET, true),
  };

  const equities = {
    alpacaApiKey: String(merged.ALPACA_API_KEY || '').trim(),
    alpacaApiSecret: String(merged.ALPACA_API_SECRET || '').trim(),
    alpacaPaper: parseBool(merged.ALPACA_PAPER, true),
    twelveDataApiKey: String(merged.TWELVEDATA_API_KEY || '').trim(),
  };

  const liveConfirmToken = String(merged.LIVE_CONFIRM_TOKEN || '').trim();
  const commercialMasterKey = String(merged.COMMERCIAL_MASTER_KEY || '').trim();
  const commercialLicenseSecret = String(merged.COMMERCIAL_LICENSE_SECRET || '').trim();
  const commercialAdminToken = String(merged.COMMERCIAL_ADMIN_TOKEN || '').trim();

  const config = {
    repoRoot: cwd,
    envPath: resolvedEnvPath,
    exchange,
    symbols,
    timeframes,
    riskTier,
    executionMode: rawMode,
    dryRun,
    maxLeverageCap,
    maxOrderUsdt,
    host,
    port,
    sqlitePath,
    allowedDataDir,
    liveConfirmToken,
    commercialMasterKey,
    commercialLicenseSecret,
    commercialAdminToken,
    okx,
    binance,
    equities,
  };

  // Non-enumerable secret getter protection against accidental JSON.stringify
  Object.defineProperty(config, 'toJSON', {
    enumerable: false,
    value: () => redactConfig(config),
  });

  return config;
}

export function hasExchangeCredentials(config, exchange = config.exchange) {
  if (exchange === 'OKX') {
    return Boolean(config?.okx?.apiKey && config?.okx?.apiSecret && config?.okx?.passphrase);
  }
  if (exchange === 'BINANCE') {
    return Boolean(config?.binance?.apiKey && config?.binance?.apiSecret);
  }
  return false;
}

/**
 * Verifies every interlock required before sending any real exchange order.
 */
export function assertLiveOrderSafety(config, providedConfirmToken, { orderNotionalUsdt } = {}) {
  if (!config || config.executionMode !== 'LIVE_ARMED') {
    throw new Error('Safety interlock: EXECUTION_MODE must be LIVE_ARMED to place live orders');
  }
  if (config.dryRun !== false) {
    throw new Error('Safety interlock: DRY_RUN must be false to place live orders');
  }
  if (!config.liveConfirmToken) {
    throw new Error('Safety interlock: LIVE_CONFIRM_TOKEN is not configured in environment');
  }
  if (!timingSafeTokenEqual(config.liveConfirmToken, providedConfirmToken)) {
    throw new Error('Safety interlock: LIVE_CONFIRM_TOKEN mismatch');
  }
  if (!hasExchangeCredentials(config, config.exchange)) {
    throw new Error(`Safety interlock: missing API credentials for ${config.exchange}`);
  }
  if (orderNotionalUsdt !== undefined) {
    if (!Number.isFinite(orderNotionalUsdt) || orderNotionalUsdt <= 0) {
      throw new Error(`Safety interlock: invalid order notional ${orderNotionalUsdt}`);
    }
    if (orderNotionalUsdt > config.maxOrderUsdt) {
      throw new Error(
        `Safety interlock: order notional ${orderNotionalUsdt} USDT exceeds MAX_ORDER_USDT (${config.maxOrderUsdt})`,
      );
    }
  }
  return true;
}

/**
 * Returns a strictly secret-free copy of config suitable for HTTP APIs and logs.
 */
export function redactConfig(config) {
  return {
    exchange: config.exchange,
    symbols: [...config.symbols],
    timeframes: [...config.timeframes],
    riskTier: config.riskTier || 'SAFE_75WR',
    executionMode: config.executionMode,
    dryRun: config.dryRun,
    maxLeverageCap: config.maxLeverageCap,
    maxOrderUsdt: config.maxOrderUsdt,
    host: config.host,
    port: config.port,
    hasLiveConfirmToken: Boolean(config.liveConfirmToken),
    okx: {
      configured: hasExchangeCredentials(config, 'OKX'),
      simulated: Boolean(config.okx?.simulated),
    },
    binance: {
      configured: hasExchangeCredentials(config, 'BINANCE'),
      testnet: Boolean(config.binance?.testnet),
    },
    equities: {
      yahooPublic: true,
      alpacaConfigured: Boolean(config.equities?.alpacaApiKey && config.equities?.alpacaApiSecret),
      alpacaPaper: Boolean(config.equities?.alpacaPaper ?? true),
      twelveDataConfigured: Boolean(config.equities?.twelveDataApiKey),
    },
    commercial: {
      masterKeyConfigured: Boolean(config.commercialMasterKey),
      licenseSecretConfigured: Boolean(config.commercialLicenseSecret),
      adminTokenConfigured: Boolean(config.commercialAdminToken),
    },
  };
}

/**
 * Scrubs any known secret string from arbitrary text before logging.
 */
export function scrubSecrets(text, config) {
  let out = String(text ?? '');
  if (!config) return out;
  const secrets = [
    config.liveConfirmToken,
    config.commercialMasterKey,
    config.commercialLicenseSecret,
    config.commercialAdminToken,
    config.okx?.apiKey,
    config.okx?.apiSecret,
    config.okx?.passphrase,
    config.binance?.apiKey,
    config.binance?.apiSecret,
    config.equities?.alpacaApiKey,
    config.equities?.alpacaApiSecret,
    config.equities?.twelveDataApiKey,
  ].filter(s => typeof s === 'string' && s.length >= 4);
  for (const secret of secrets) {
    out = out.split(secret).join('[REDACTED]');
  }
  for (const key of SECRET_KEYS) {
    const re = new RegExp(`(${key}\\s*=\\s*)([^\\s"']+|"[^"]*"|'[^']*')`, 'gi');
    out = out.replace(re, '$1[REDACTED]');
  }
  return out;
}
