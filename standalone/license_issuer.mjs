import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let cachedEphemeralSigningSecret = null;

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    deepFreeze(val);
  }
  return obj;
}

export const COMMERCIAL_PLANS = deepFreeze({
  STARTER_SCAN_SIGNAL: {
    id: 'STARTER_SCAN_SIGNAL',
    name: 'Starter Scan & Signal',
    priceUsdMonthly: 29,
    allowedModes: ['SCAN_AND_SIGNAL_ONLY'],
    maxCapitalUsdt: 5000,
    maxConcurrentPositions: 2,
    allowedSymbols: ['BTCUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P'],
    allowedVersions: ['v6', 'v8', 'v9'],
  },
  PRO_AUTO_TRADER: {
    id: 'PRO_AUTO_TRADER',
    name: 'Pro Auto-Trader',
    priceUsdMonthly: 79,
    allowedModes: ['SCAN_AND_SIGNAL_ONLY', 'DEMO_AUTO_TRADE', 'LIVE_AUTO_TRADE'],
    maxCapitalUsdt: 25000,
    maxConcurrentPositions: 4,
    allowedSymbols: ['BTCUSDT.P', 'ETHUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P'],
    allowedVersions: ['v4.1', 'v5', 'v6', 'v7', 'v8', 'v9'],
  },
  INSTITUTIONAL_VIP: {
    id: 'INSTITUTIONAL_VIP',
    name: 'Institutional VIP',
    priceUsdMonthly: 199,
    allowedModes: ['SCAN_AND_SIGNAL_ONLY', 'DEMO_AUTO_TRADE', 'LIVE_AUTO_TRADE'],
    maxCapitalUsdt: 250000,
    maxConcurrentPositions: 8,
    allowedSymbols: ['BTCUSDT.P', 'ETHUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P', 'SPY', 'DIA', 'QQQ'],
    allowedVersions: ['v4.1', 'v5', 'v6', 'v7', 'v8', 'v9'],
  },
});

export function resolveLicenseSigningSecret(config) {
  const explicit = typeof config?.commercialLicenseSecret === 'string'
    ? config.commercialLicenseSecret
    : (typeof config?.COMMERCIAL_LICENSE_SECRET === 'string' ? config.COMMERCIAL_LICENSE_SECRET : '');

  if (explicit.trim().length > 0) {
    return explicit.trim();
  }
  if (!cachedEphemeralSigningSecret) {
    cachedEphemeralSigningSecret = crypto.randomBytes(32).toString('hex');
  }
  return cachedEphemeralSigningSecret;
}

function computeHmacTag24(bodyB64, signingSecret) {
  return crypto
    .createHmac('sha256', signingSecret)
    .update(bodyB64)
    .digest('base64url')
    .slice(0, 24);
}

/**
 * Issues a signed commercial license key (`TT10.<b64url>.<hmac24>`).
 */
export function issueLicenseKey({
  planId,
  subscriberRef,
  durationDays = 30,
  maxCapitalUsdtOverride = null,
  signingSecret,
} = {}) {
  const plan = COMMERCIAL_PLANS[planId];
  assert.ok(plan, `Unknown commercial planId: ${planId}`);
  assert.ok(typeof subscriberRef === 'string' && subscriberRef.trim().length > 0,
    'subscriberRef must be a non-empty string');
  assert.ok(Number.isFinite(durationDays) && durationDays > 0, 'durationDays must be > 0');
  assert.ok(
    (typeof signingSecret === 'string' && signingSecret.length > 0) || Buffer.isBuffer(signingSecret),
    'signingSecret must be non-empty',
  );

  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + Math.round(durationDays * 86400 * 1000);
  const expiresAtIso = new Date(expiresAtMs).toISOString();
  const maxCapitalUsdt = (
    maxCapitalUsdtOverride !== null &&
    maxCapitalUsdtOverride !== undefined &&
    Number.isFinite(Number(maxCapitalUsdtOverride)) &&
    Number(maxCapitalUsdtOverride) > 0
  )
    ? Number(maxCapitalUsdtOverride)
    : plan.maxCapitalUsdt;

  const payload = {
    v: 1,
    planId: plan.id,
    subscriberRef: subscriberRef.trim(),
    issuedAtMs,
    expiresAtMs,
    maxCapitalUsdt,
  };

  const bodyB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const tag24 = computeHmacTag24(bodyB64, signingSecret);
  const licenseKey = `TT10.${bodyB64}.${tag24}`;

  return { licenseKey, payload, expiresAtIso };
}

/**
 * Verifies a `TT10.<b64url>.<hmac24>` license key using constant-time HMAC comparison
 * and checks expiration against `nowMs`.
 */
export function verifyLicenseKey(licenseKey, signingSecret, nowMs = Date.now()) {
  if (typeof licenseKey !== 'string' || !licenseKey.startsWith('TT10.')) {
    return { valid: false, reason: 'INVALID_FORMAT', plan: null, payload: null };
  }
  if (!(typeof signingSecret === 'string' && signingSecret.length > 0) && !Buffer.isBuffer(signingSecret)) {
    return { valid: false, reason: 'MISSING_SIGNING_SECRET', plan: null, payload: null };
  }

  const parts = licenseKey.split('.');
  if (parts.length !== 3 || parts[0] !== 'TT10' || !parts[1] || parts[2].length !== 24) {
    return { valid: false, reason: 'INVALID_FORMAT', plan: null, payload: null };
  }

  const [, bodyB64, providedTag] = parts;
  const expectedTag = computeHmacTag24(bodyB64, signingSecret);
  const providedBuf = Buffer.from(providedTag, 'utf8');
  const expectedBuf = Buffer.from(expectedTag, 'utf8');
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: 'INVALID_SIGNATURE', plan: null, payload: null };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'MALFORMED_PAYLOAD', plan: null, payload: null };
  }

  const plan = COMMERCIAL_PLANS[payload?.planId] ?? null;
  if (!plan) {
    return { valid: false, reason: 'UNKNOWN_PLAN', plan: null, payload };
  }

  if (!Number.isFinite(payload.expiresAtMs) || payload.expiresAtMs <= nowMs) {
    return { valid: false, reason: 'LICENSE_EXPIRED', plan, payload };
  }

  return { valid: true, reason: 'VALID', plan, payload };
}
