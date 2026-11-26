import assert from 'node:assert/strict';

const COMMERCIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS commercial_subscribers (
  subscriber_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  session_token_hash TEXT NOT NULL,
  arming_pin_hash TEXT,
  license_key TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  license_expires_at INTEGER NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'OKX',
  simulated INTEGER NOT NULL DEFAULT 1,
  execution_mode TEXT NOT NULL DEFAULT 'SCAN_AND_SIGNAL_ONLY',
  preferred_version TEXT NOT NULL DEFAULT 'v9',
  risk_tier TEXT NOT NULL DEFAULT 'SAFE_75WR',
  risk_pct REAL NOT NULL DEFAULT 1.0,
  max_leverage_cap REAL NOT NULL DEFAULT 3.0,
  max_daily_loss_pct REAL NOT NULL DEFAULT 5.0,
  max_dd_kill_pct REAL NOT NULL DEFAULT 20.0,
  webhook_url TEXT,
  is_paper_sandbox INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriber_credentials_enc (
  subscriber_id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  key_mask TEXT NOT NULL,
  has_withdraw_perm INTEGER NOT NULL DEFAULT 0,
  permission_summary TEXT,
  envelope_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriber_account_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id TEXT NOT NULL,
  exchange TEXT NOT NULL,
  scanned_mode TEXT NOT NULL,
  total_equity_usdt REAL NOT NULL,
  avail_margin_usdt REAL NOT NULL,
  open_positions_json TEXT NOT NULL,
  capital_bracket TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriber_signal_tickets (
  ticket_id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  bar_time INTEGER NOT NULL,
  side INTEGER NOT NULL,
  status TEXT NOT NULL,
  regime TEXT,
  prob_win REAL,
  entry_px REAL,
  sl_px REAL,
  tp_px REAL,
  sz_or_qty TEXT,
  notional_usdt REAL,
  est_risk_usdt REAL,
  est_profit_usdt REAL,
  est_liq_px REAL,
  feasible INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  model_version TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriber_orders_log (
  client_order_id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL,
  order_type TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL,
  qty TEXT,
  reduce_only INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  exchange_order_id TEXT,
  payload_json TEXT,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriber_risk_state (
  subscriber_id TEXT PRIMARY KEY,
  day_utc TEXT NOT NULL,
  day_start_equity_usdt REAL NOT NULL,
  high_water_equity_usdt REAL NOT NULL,
  last_equity_usdt REAL NOT NULL,
  daily_loss_pct REAL NOT NULL DEFAULT 0,
  drawdown_pct REAL NOT NULL DEFAULT 0,
  circuit_breaker_tripped INTEGER NOT NULL DEFAULT 0,
  kill_switch_tripped INTEGER NOT NULL DEFAULT 0,
  trip_reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autopilot_sessions (
  subscriber_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'DISARMED',
  interval_sec INTEGER NOT NULL DEFAULT 60,
  timeframe TEXT NOT NULL DEFAULT '1h',
  execution_mode TEXT NOT NULL DEFAULT 'SCAN_AND_SIGNAL_ONLY',
  cycle_count INTEGER NOT NULL DEFAULT 0,
  last_tick_at INTEGER,
  next_tick_at INTEGER,
  last_cycle_status TEXT,
  last_error TEXT,
  armed_at INTEGER,
  disarmed_at INTEGER,
  disarm_reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autopilot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'INFO',
  message TEXT NOT NULL,
  details_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autopilot_events_sub ON autopilot_events(subscriber_id, id DESC);
`;

const FORBIDDEN_SECRET_FIELDS = new Set(['apiSecret', 'passphrase', 'armingPin', 'sessionToken']);

function sanitizeEventDetails(details) {
  if (details === null || details === undefined) return null;
  if (typeof details !== 'object') return details;
  if (Array.isArray(details)) return details.map(item => sanitizeEventDetails(item));
  const clean = {};
  for (const [k, v] of Object.entries(details)) {
    if (FORBIDDEN_SECRET_FIELDS.has(k)) continue;
    clean[k] = typeof v === 'object' && v !== null ? sanitizeEventDetails(v) : v;
  }
  return clean;
}

function formatAutopilotSessionRow(row) {
  if (!row) return null;
  return {
    ...row,
    subscriberId: row.subscriber_id,
    intervalSec: row.interval_sec,
    executionMode: row.execution_mode,
    cycleCount: row.cycle_count,
    lastTickAt: row.last_tick_at,
    nextTickAt: row.next_tick_at,
    lastCycleStatus: row.last_cycle_status,
    lastError: row.last_error,
    armedAt: row.armed_at,
    disarmedAt: row.disarmed_at,
    disarmReason: row.disarm_reason,
    updatedAt: row.updated_at,
  };
}

function formatAutopilotEventRow(row) {
  if (!row) return null;
  return {
    ...row,
    subscriberId: row.subscriber_id,
    eventType: row.event_type,
    details: safeJsonParse(row.details_json, null),
    createdAt: row.created_at,
  };
}

function safeJsonParse(raw, fallback = null) {
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Multi-tenant SQLite WAL store for Commercial Subscribers, Encrypted Credentials,
 * Personalized Account Scans/Tickets, Risk Guardrails, and Idempotent Subscriber Orders.
 */
export class CommercialStore {
  constructor(standaloneStore) {
    assert.ok(standaloneStore, 'StandaloneStore or DatabaseSync instance is required');
    this.store = standaloneStore;
    this.db = standaloneStore.db || standaloneStore;
    assert.ok(this.db && typeof this.db.exec === 'function', 'Expected SQLite DatabaseSync handle');
    this.db.exec(COMMERCIAL_SCHEMA_SQL);
    const subCols = this.db.prepare('PRAGMA table_info(commercial_subscribers)').all().map(c => c.name);
    if (!subCols.includes('is_paper_sandbox')) {
      this.db.exec('ALTER TABLE commercial_subscribers ADD COLUMN is_paper_sandbox INTEGER NOT NULL DEFAULT 0;');
    }
  }

  runTx(fn) {
    if (this.store && typeof this.store.runTransaction === 'function') {
      return this.store.runTransaction(fn);
    }
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const out = fn();
      this.db.exec('COMMIT;');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  upsertSubscriber(sub) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO commercial_subscribers (
        subscriber_id, name, email, session_token_hash, arming_pin_hash,
        license_key, plan_id, license_expires_at, exchange, simulated,
        execution_mode, preferred_version, risk_tier, risk_pct,
        max_leverage_cap, max_daily_loss_pct, max_dd_kill_pct,
        webhook_url, is_paper_sandbox, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscriber_id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        session_token_hash = excluded.session_token_hash,
        arming_pin_hash = excluded.arming_pin_hash,
        license_key = excluded.license_key,
        plan_id = excluded.plan_id,
        license_expires_at = excluded.license_expires_at,
        exchange = excluded.exchange,
        simulated = excluded.simulated,
        execution_mode = excluded.execution_mode,
        preferred_version = excluded.preferred_version,
        risk_tier = excluded.risk_tier,
        risk_pct = excluded.risk_pct,
        max_leverage_cap = excluded.max_leverage_cap,
        max_daily_loss_pct = excluded.max_daily_loss_pct,
        max_dd_kill_pct = excluded.max_dd_kill_pct,
        webhook_url = excluded.webhook_url,
        is_paper_sandbox = excluded.is_paper_sandbox,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      sub.subscriberId,
      sub.name,
      sub.email ?? null,
      sub.sessionTokenHash,
      sub.armingPinHash ?? null,
      sub.licenseKey,
      sub.planId,
      Number(sub.licenseExpiresAt),
      sub.exchange || 'OKX',
      sub.simulated ? 1 : 0,
      sub.executionMode || 'SCAN_AND_SIGNAL_ONLY',
      sub.preferredVersion || 'v9',
      sub.riskTier || 'SAFE_75WR',
      Number(sub.riskPct ?? 1.0),
      Number(sub.maxLeverageCap ?? 3.0),
      Number(sub.maxDailyLossPct ?? 5.0),
      Number(sub.maxDdKillPct ?? 20.0),
      sub.webhookUrl ?? null,
      sub.isPaperSandbox ? 1 : 0,
      sub.status || 'ACTIVE',
      Number(sub.createdAt ?? now),
      now,
    );
    return this.getSubscriberById(sub.subscriberId);
  }

  getPaperSandboxSubscriber() {
    return this.db
      .prepare(`SELECT * FROM commercial_subscribers WHERE (is_paper_sandbox = 1 OR email = 'paper-sandbox@local') AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`)
      .get() || null;
  }

  findMatchingActiveSubscriber({ subscriberId = null } = {}) {
    if (!subscriberId || typeof subscriberId !== 'string' || !subscriberId.trim()) {
      return null;
    }
    const byId = this.getSubscriberById(subscriberId.trim());
    if (byId && byId.status === 'ACTIVE') return byId;
    return null;
  }

  findActiveSubscriberByLicenseKey(licenseKey, excludeSubscriberId = null) {
    const key = typeof licenseKey === 'string' ? licenseKey.trim() : '';
    if (!key) return null;
    if (excludeSubscriberId) {
      return this.db
        .prepare(`SELECT * FROM commercial_subscribers WHERE license_key = ? AND status = 'ACTIVE' AND is_paper_sandbox = 0 AND subscriber_id != ? LIMIT 1`)
        .get(key, excludeSubscriberId) || null;
    }
    return this.db
      .prepare(`SELECT * FROM commercial_subscribers WHERE license_key = ? AND status = 'ACTIVE' AND is_paper_sandbox = 0 LIMIT 1`)
      .get(key) || null;
  }

  getSubscriberById(subscriberId) {
    return this.db
      .prepare('SELECT * FROM commercial_subscribers WHERE subscriber_id = ?')
      .get(subscriberId) || null;
  }

  getSubscriberByTokenHash(sessionTokenHash) {
    return this.db
      .prepare('SELECT * FROM commercial_subscribers WHERE session_token_hash = ?')
      .get(sessionTokenHash) || null;
  }

  listSubscribers(limit = 200) {
    return this.db
      .prepare('SELECT * FROM commercial_subscribers ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  }

  updateSubscriberSettings(subscriberId, patch = {}) {
    const cur = this.getSubscriberById(subscriberId);
    if (!cur) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE commercial_subscribers SET
        session_token_hash = ?,
        execution_mode = ?,
        preferred_version = ?,
        risk_tier = ?,
        risk_pct = ?,
        max_leverage_cap = ?,
        max_daily_loss_pct = ?,
        max_dd_kill_pct = ?,
        simulated = ?,
        arming_pin_hash = ?,
        status = ?,
        updated_at = ?
      WHERE subscriber_id = ?
    `).run(
      patch.sessionTokenHash ?? cur.session_token_hash,
      patch.executionMode ?? cur.execution_mode,
      patch.preferredVersion ?? cur.preferred_version,
      patch.riskTier ?? cur.risk_tier,
      Number(patch.riskPct ?? cur.risk_pct),
      Number(patch.maxLeverageCap ?? cur.max_leverage_cap),
      Number(patch.maxDailyLossPct ?? cur.max_daily_loss_pct),
      Number(patch.maxDdKillPct ?? cur.max_dd_kill_pct),
      patch.simulated !== undefined ? (patch.simulated ? 1 : 0) : cur.simulated,
      patch.armingPinHash !== undefined ? patch.armingPinHash : cur.arming_pin_hash,
      patch.status ?? cur.status,
      now,
      subscriberId,
    );
    return this.getSubscriberById(subscriberId);
  }

  updateSubscriberProfile(subscriberId, patch = {}) {
    const cur = this.getSubscriberById(subscriberId);
    if (!cur) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE commercial_subscribers SET
        name = ?,
        email = ?,
        exchange = ?,
        plan_id = ?,
        license_key = ?,
        license_expires_at = ?,
        session_token_hash = ?,
        execution_mode = ?,
        preferred_version = ?,
        risk_tier = ?,
        risk_pct = ?,
        max_leverage_cap = ?,
        max_daily_loss_pct = ?,
        max_dd_kill_pct = ?,
        simulated = ?,
        arming_pin_hash = ?,
        is_paper_sandbox = ?,
        status = ?,
        updated_at = ?
      WHERE subscriber_id = ?
    `).run(
      patch.name !== undefined ? patch.name : cur.name,
      patch.email !== undefined ? patch.email : cur.email,
      patch.exchange !== undefined ? String(patch.exchange).trim().toUpperCase() : cur.exchange,
      patch.planId ?? cur.plan_id,
      patch.licenseKey ?? cur.license_key,
      patch.licenseExpiresAt !== undefined ? Number(patch.licenseExpiresAt) : cur.license_expires_at,
      patch.sessionTokenHash ?? cur.session_token_hash,
      patch.executionMode ?? cur.execution_mode,
      patch.preferredVersion ?? cur.preferred_version,
      patch.riskTier ?? cur.risk_tier,
      Number(patch.riskPct ?? cur.risk_pct),
      Number(patch.maxLeverageCap ?? cur.max_leverage_cap),
      Number(patch.maxDailyLossPct ?? cur.max_daily_loss_pct),
      Number(patch.maxDdKillPct ?? cur.max_dd_kill_pct),
      patch.simulated !== undefined ? (patch.simulated ? 1 : 0) : cur.simulated,
      patch.armingPinHash !== undefined ? patch.armingPinHash : cur.arming_pin_hash,
      patch.isPaperSandbox !== undefined ? (patch.isPaperSandbox ? 1 : 0) : cur.is_paper_sandbox,
      patch.status ?? cur.status,
      now,
      subscriberId,
    );
    return this.getSubscriberById(subscriberId);
  }

  deleteSubscriberCascade(subscriberId) {
    assert.ok(subscriberId, 'subscriberId is required for deleteSubscriberCascade');
    return this.runTx(() => {
      const existing = this.getSubscriberById(subscriberId);
      if (!existing) {
        return { deleted: false, subscriberId, changes: 0 };
      }
      const tables = [
        'autopilot_events',
        'autopilot_sessions',
        'subscriber_risk_state',
        'subscriber_orders_log',
        'subscriber_signal_tickets',
        'subscriber_account_scans',
        'subscriber_credentials_enc',
      ];
      let totalChanges = 0;
      for (const tbl of tables) {
        const r = this.db.prepare(`DELETE FROM ${tbl} WHERE subscriber_id = ?`).run(subscriberId);
        totalChanges += Number(r?.changes ?? 0);
      }
      const subRes = this.db.prepare('DELETE FROM commercial_subscribers WHERE subscriber_id = ?').run(subscriberId);
      const subChanges = Number(subRes?.changes ?? 0);
      totalChanges += subChanges;
      return { deleted: subChanges > 0, subscriberId, changes: totalChanges };
    });
  }

  upsertEncryptedCredentials({ subscriberId, exchange, keyMask, hasWithdrawPerm = false, permissionSummary = '', envelope }) {
    const now = Date.now();
    const envJson = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
    this.db.prepare(`
      INSERT INTO subscriber_credentials_enc (
        subscriber_id, exchange, key_mask, has_withdraw_perm, permission_summary, envelope_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscriber_id) DO UPDATE SET
        exchange = excluded.exchange,
        key_mask = excluded.key_mask,
        has_withdraw_perm = excluded.has_withdraw_perm,
        permission_summary = excluded.permission_summary,
        envelope_json = excluded.envelope_json,
        updated_at = excluded.updated_at
    `).run(
      subscriberId,
      exchange || 'OKX',
      keyMask,
      hasWithdrawPerm ? 1 : 0,
      permissionSummary || '',
      envJson,
      now,
    );
  }

  getEncryptedCredentials(subscriberId) {
    const row = this.db
      .prepare('SELECT * FROM subscriber_credentials_enc WHERE subscriber_id = ?')
      .get(subscriberId);
    if (!row) return null;
    return {
      ...row,
      hasWithdrawPerm: Boolean(row.has_withdraw_perm),
      envelope: safeJsonParse(row.envelope_json, null),
    };
  }

  insertAccountScan({ subscriberId, exchange, scannedMode, totalEquityUsdt, availMarginUsdt, openPositions = [], capitalBracket }) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO subscriber_account_scans (
        subscriber_id, exchange, scanned_mode, total_equity_usdt, avail_margin_usdt, open_positions_json, capital_bracket, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      subscriberId,
      exchange,
      scannedMode,
      Number(totalEquityUsdt),
      Number(availMarginUsdt),
      JSON.stringify(openPositions || []),
      capitalBracket,
      now,
    );
    return this.getLatestAccountScan(subscriberId);
  }

  getLatestAccountScan(subscriberId) {
    const row = this.db
      .prepare('SELECT * FROM subscriber_account_scans WHERE subscriber_id = ? ORDER BY id DESC LIMIT 1')
      .get(subscriberId);
    if (!row) return null;
    return {
      ...row,
      openPositions: safeJsonParse(row.open_positions_json, []),
    };
  }

  listAccountScans(subscriberId, limit = 50) {
    return this.db
      .prepare('SELECT * FROM subscriber_account_scans WHERE subscriber_id = ? ORDER BY id DESC LIMIT ?')
      .all(subscriberId, limit)
      .map(row => ({
        ...row,
        totalEquityUsdt: row.total_equity_usdt,
        availMarginUsdt: row.avail_margin_usdt,
        capitalBracket: row.capital_bracket,
        scannedMode: row.scanned_mode,
        createdAt: row.created_at,
        openPositions: safeJsonParse(row.open_positions_json, []),
      }));
  }

  upsertSignalTickets(subscriberId, tickets = []) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO subscriber_signal_tickets (
        ticket_id, subscriber_id, symbol, timeframe, bar_time, side, status, regime,
        prob_win, entry_px, sl_px, tp_px, sz_or_qty, notional_usdt,
        est_risk_usdt, est_profit_usdt, est_liq_px, feasible, skip_reason, model_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET
        status = excluded.status,
        regime = excluded.regime,
        prob_win = excluded.prob_win,
        entry_px = excluded.entry_px,
        sl_px = excluded.sl_px,
        tp_px = excluded.tp_px,
        sz_or_qty = excluded.sz_or_qty,
        notional_usdt = excluded.notional_usdt,
        est_risk_usdt = excluded.est_risk_usdt,
        est_profit_usdt = excluded.est_profit_usdt,
        est_liq_px = excluded.est_liq_px,
        feasible = excluded.feasible,
        skip_reason = excluded.skip_reason,
        model_version = excluded.model_version
    `);
    this.runTx(() => {
      for (const tk of tickets) {
        stmt.run(
          tk.ticketId,
          subscriberId,
          tk.symbol,
          tk.timeframe,
          Number(tk.barTime ?? 0),
          Number(tk.side ?? 1),
          tk.status,
          tk.regime ?? null,
          tk.probWin !== undefined && tk.probWin !== null ? Number(tk.probWin) : null,
          tk.entryPx !== undefined && tk.entryPx !== null ? Number(tk.entryPx) : null,
          tk.slPx !== undefined && tk.slPx !== null ? Number(tk.slPx) : null,
          tk.tpPx !== undefined && tk.tpPx !== null ? Number(tk.tpPx) : null,
          tk.szOrQty !== undefined && tk.szOrQty !== null ? String(tk.szOrQty) : '0',
          Number(tk.notionalUsdt ?? 0),
          Number(tk.estRiskUsdt ?? 0),
          Number(tk.estProfitUsdt ?? 0),
          Number(tk.estLiqPx ?? 0),
          tk.feasible ? 1 : 0,
          tk.skipReason ?? null,
          tk.modelVersion ?? null,
          Number(tk.createdAt ?? now),
        );
      }
    });
  }

  listSignalTickets(subscriberId, limit = 50) {
    return this.db
      .prepare('SELECT * FROM subscriber_signal_tickets WHERE subscriber_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(subscriberId, limit)
      .map(r => ({ ...r, feasible: Boolean(r.feasible) }));
  }

  upsertSubscriberOrderLog(ord) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO subscriber_orders_log (
        client_order_id, subscriber_id, exchange, symbol, mode, order_type, side,
        price, qty, reduce_only, status, exchange_order_id, payload_json, response_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_order_id) DO UPDATE SET
        status = excluded.status,
        exchange_order_id = COALESCE(excluded.exchange_order_id, subscriber_orders_log.exchange_order_id),
        payload_json = COALESCE(excluded.payload_json, subscriber_orders_log.payload_json),
        response_json = COALESCE(excluded.response_json, subscriber_orders_log.response_json),
        updated_at = excluded.updated_at
    `).run(
      ord.clientOrderId,
      ord.subscriberId,
      ord.exchange,
      ord.symbol,
      ord.mode,
      ord.orderType,
      ord.side,
      ord.price !== undefined && ord.price !== null ? Number(ord.price) : null,
      ord.qty !== undefined && ord.qty !== null ? String(ord.qty) : '0',
      ord.reduceOnly ? 1 : 0,
      ord.status,
      ord.exchangeOrderId ?? null,
      ord.payload ? JSON.stringify(ord.payload) : null,
      ord.response ? JSON.stringify(ord.response) : null,
      Number(ord.createdAt ?? now),
      now,
    );
  }

  findSubscriberOrder(clientOrderId, subscriberId = null) {
    const row = subscriberId
      ? this.db
          .prepare('SELECT * FROM subscriber_orders_log WHERE client_order_id = ? AND subscriber_id = ?')
          .get(clientOrderId, subscriberId)
      : this.db
          .prepare('SELECT * FROM subscriber_orders_log WHERE client_order_id = ?')
          .get(clientOrderId);
    if (!row) return null;
    return {
      ...row,
      reduceOnly: Boolean(row.reduce_only),
      payload: safeJsonParse(row.payload_json, null),
      response: safeJsonParse(row.response_json, null),
    };
  }

  getSubscriberOrdersLog({ subscriberId = null, limit = 50 } = {}) {
    const rows = subscriberId
      ? this.db
          .prepare('SELECT * FROM subscriber_orders_log WHERE subscriber_id = ? ORDER BY updated_at DESC LIMIT ?')
          .all(subscriberId, limit)
      : this.db
          .prepare('SELECT * FROM subscriber_orders_log ORDER BY updated_at DESC LIMIT ?')
          .all(limit);
    return rows.map(row => ({
      ...row,
      reduceOnly: Boolean(row.reduce_only),
      payload: safeJsonParse(row.payload_json, null),
      response: safeJsonParse(row.response_json, null),
    }));
  }

  recoverInterruptedSubscriberOrders() {
    const res = this.db
      .prepare(`UPDATE subscriber_orders_log SET status = 'INTERRUPTED', updated_at = ? WHERE status = 'SUBMITTING'`)
      .run(Date.now());
    return Number(res?.changes ?? 0);
  }

  upsertRiskState(risk) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO subscriber_risk_state (
        subscriber_id, day_utc, day_start_equity_usdt, high_water_equity_usdt, last_equity_usdt,
        daily_loss_pct, drawdown_pct, circuit_breaker_tripped, kill_switch_tripped, trip_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscriber_id) DO UPDATE SET
        day_utc = excluded.day_utc,
        day_start_equity_usdt = excluded.day_start_equity_usdt,
        high_water_equity_usdt = excluded.high_water_equity_usdt,
        last_equity_usdt = excluded.last_equity_usdt,
        daily_loss_pct = excluded.daily_loss_pct,
        drawdown_pct = excluded.drawdown_pct,
        circuit_breaker_tripped = excluded.circuit_breaker_tripped,
        kill_switch_tripped = excluded.kill_switch_tripped,
        trip_reason = excluded.trip_reason,
        updated_at = excluded.updated_at
    `).run(
      risk.subscriberId,
      risk.dayUtc,
      Number(risk.dayStartEquityUsdt),
      Number(risk.highWaterEquityUsdt),
      Number(risk.lastEquityUsdt),
      Number(risk.dailyLossPct ?? 0),
      Number(risk.drawdownPct ?? 0),
      risk.circuitBreakerTripped ? 1 : 0,
      risk.killSwitchTripped ? 1 : 0,
      risk.tripReason ?? null,
      now,
    );
    return this.getRiskState(risk.subscriberId);
  }

  getRiskState(subscriberId) {
    const row = this.db
      .prepare('SELECT * FROM subscriber_risk_state WHERE subscriber_id = ?')
      .get(subscriberId);
    if (!row) return null;
    return {
      ...row,
      circuitBreakerTripped: Boolean(row.circuit_breaker_tripped),
      killSwitchTripped: Boolean(row.kill_switch_tripped),
    };
  }

  upsertAutopilotSession(session) {
    assert.ok(session?.subscriberId, 'subscriberId is required for upsertAutopilotSession');
    const now = Date.now();
    const cur = this.getAutopilotSession(session.subscriberId);
    this.db.prepare(`
      INSERT INTO autopilot_sessions (
        subscriber_id, state, interval_sec, timeframe, execution_mode, cycle_count,
        last_tick_at, next_tick_at, last_cycle_status, last_error,
        armed_at, disarmed_at, disarm_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscriber_id) DO UPDATE SET
        state = excluded.state,
        interval_sec = excluded.interval_sec,
        timeframe = excluded.timeframe,
        execution_mode = excluded.execution_mode,
        cycle_count = excluded.cycle_count,
        last_tick_at = excluded.last_tick_at,
        next_tick_at = excluded.next_tick_at,
        last_cycle_status = excluded.last_cycle_status,
        last_error = excluded.last_error,
        armed_at = excluded.armed_at,
        disarmed_at = excluded.disarmed_at,
        disarm_reason = excluded.disarm_reason,
        updated_at = excluded.updated_at
    `).run(
      session.subscriberId,
      session.state ?? cur?.state ?? 'DISARMED',
      Number(session.intervalSec ?? cur?.interval_sec ?? 60),
      session.timeframe ?? cur?.timeframe ?? '1h',
      session.executionMode ?? cur?.execution_mode ?? 'SCAN_AND_SIGNAL_ONLY',
      Number(session.cycleCount ?? cur?.cycle_count ?? 0),
      session.lastTickAt !== undefined ? session.lastTickAt : (cur?.last_tick_at ?? null),
      session.nextTickAt !== undefined ? session.nextTickAt : (cur?.next_tick_at ?? null),
      session.lastCycleStatus !== undefined ? session.lastCycleStatus : (cur?.last_cycle_status ?? null),
      session.lastError !== undefined ? session.lastError : (cur?.last_error ?? null),
      session.armedAt !== undefined ? session.armedAt : (cur?.armed_at ?? null),
      session.disarmedAt !== undefined ? session.disarmedAt : (cur?.disarmed_at ?? null),
      session.disarmReason !== undefined ? session.disarmReason : (cur?.disarm_reason ?? null),
      now,
    );
    return this.getAutopilotSession(session.subscriberId);
  }

  getAutopilotSession(subscriberId) {
    const row = this.db
      .prepare('SELECT * FROM autopilot_sessions WHERE subscriber_id = ?')
      .get(subscriberId);
    return formatAutopilotSessionRow(row);
  }

  listAutopilotSessions(limit = 200) {
    return this.db
      .prepare('SELECT * FROM autopilot_sessions ORDER BY updated_at DESC LIMIT ?')
      .all(limit)
      .map(formatAutopilotSessionRow);
  }

  insertAutopilotEvent({ subscriberId, eventType, level = 'INFO', message = '', details = null, createdAt = Date.now() } = {}) {
    assert.ok(subscriberId, 'subscriberId is required for insertAutopilotEvent');
    assert.ok(eventType, 'eventType is required for insertAutopilotEvent');
    const cleanDetails = sanitizeEventDetails(details);
    const detailsJson = cleanDetails !== null && cleanDetails !== undefined ? JSON.stringify(cleanDetails) : null;
    const res = this.db.prepare(`
      INSERT INTO autopilot_events (
        subscriber_id, event_type, level, message, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      subscriberId,
      String(eventType),
      String(level || 'INFO'),
      String(message || ''),
      detailsJson,
      Number(createdAt ?? Date.now()),
    );
    const row = this.db
      .prepare('SELECT * FROM autopilot_events WHERE id = ?')
      .get(res.lastInsertRowid);
    return formatAutopilotEventRow(row);
  }

  listAutopilotEvents(arg1 = {}, arg2 = 50) {
    const opts = typeof arg1 === 'string'
      ? { subscriberId: arg1, limit: arg2 }
      : (arg1 || {});
    const subscriberId = opts.subscriberId ?? null;
    const limit = Number(opts.limit ?? 50);
    const rows = subscriberId
      ? this.db
          .prepare('SELECT * FROM autopilot_events WHERE subscriber_id = ? ORDER BY id DESC LIMIT ?')
          .all(subscriberId, limit)
      : this.db
          .prepare('SELECT * FROM autopilot_events ORDER BY id DESC LIMIT ?')
          .all(limit);
    return rows.map(formatAutopilotEventRow);
  }

  recoverInterruptedAutopilotSessions() {
    const now = Date.now();
    return this.runTx(() => {
      const armedRows = this.db
        .prepare(`SELECT subscriber_id FROM autopilot_sessions WHERE state = 'ARMED_RUNNING'`)
        .all();
      if (armedRows.length === 0) return 0;

      const res = this.db.prepare(`
        UPDATE autopilot_sessions
        SET state = 'REARM_REQUIRED',
            disarm_reason = 'SERVER_RESTART_PIN_REARM_REQUIRED',
            disarmed_at = ?,
            next_tick_at = NULL,
            updated_at = ?
        WHERE state = 'ARMED_RUNNING'
      `).run(now, now);

      for (const r of armedRows) {
        this.insertAutopilotEvent({
          subscriberId: r.subscriber_id,
          eventType: 'REARM_REQUIRED',
          level: 'WARN',
          message: 'Server restarted; PIN re-arming required to resume Autopilot.',
          details: { reason: 'SERVER_RESTART_PIN_REARM_REQUIRED' },
          createdAt: now,
        });
      }
      return Number(res?.changes ?? armedRows.length);
    });
  }
}
