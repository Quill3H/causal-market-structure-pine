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
`;

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
        webhook_url, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      sub.status || 'ACTIVE',
      Number(sub.createdAt ?? now),
      now,
    );
    return this.getSubscriberById(sub.subscriberId);
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

  findSubscriberOrder(clientOrderId) {
    const row = this.db
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
}
