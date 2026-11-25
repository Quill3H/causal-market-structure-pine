import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Resolves and guards a SQLite file path inside an allowed base directory.
 * Prevents path traversal and symlink escapes outside allowedBaseDir.
 */
export function resolveSafeSqlitePath(sqlitePath, allowedBaseDir) {
  if (!sqlitePath || typeof sqlitePath !== 'string' || sqlitePath.includes('\0')) {
    throw new Error('Invalid SQLite path');
  }
  if (!allowedBaseDir || typeof allowedBaseDir !== 'string') {
    throw new Error('allowedBaseDir is required for SQLite path safety');
  }
  const baseResolved = path.resolve(allowedBaseDir);
  const targetResolved = path.resolve(baseResolved, sqlitePath);
  const rel = path.relative(baseResolved, targetResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    throw new Error(`SQLite path "${sqlitePath}" escapes allowed directory "${baseResolved}"`);
  }

  // Ensure parent dir exists and check symlinks safely
  const parentDir = path.dirname(targetResolved);
  fs.mkdirSync(parentDir, { recursive: true });
  const baseReal = fs.existsSync(baseResolved) ? fs.realpathSync(baseResolved) : baseResolved;
  const parentReal = fs.realpathSync(parentDir);
  const parentRel = path.relative(baseReal, parentReal);
  if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
    throw new Error(`SQLite parent directory resolves via symlink outside "${baseReal}"`);
  }
  if (fs.existsSync(targetResolved)) {
    const stat = fs.lstatSync(targetResolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`SQLite file "${targetResolved}" cannot be a symlink`);
    }
  }
  return targetResolved;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS candles (
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  closed INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, symbol, timeframe, time)
);

CREATE TABLE IF NOT EXISTS funding_rates (
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  time INTEGER NOT NULL,
  funding_rate REAL NOT NULL,
  realized_rate REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, symbol, time)
);

CREATE TABLE IF NOT EXISTS signals_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  bar_time INTEGER NOT NULL,
  bar_index INTEGER NOT NULL,
  side INTEGER NOT NULL,
  limit_price REAL,
  atr REAL,
  prob_win REAL,
  model_version TEXT,
  decision TEXT NOT NULL,
  size_mult REAL NOT NULL DEFAULT 1.0,
  features_json TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (exchange, symbol, timeframe, bar_time, side)
);

CREATE TABLE IF NOT EXISTS paper_state (
  id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side INTEGER NOT NULL,
  entry_time INTEGER NOT NULL,
  exit_time INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  target_price REAL NOT NULL,
  lev REAL NOT NULL,
  prob_win REAL,
  exit_reason TEXT NOT NULL,
  gross_pct REAL NOT NULL,
  net_pct REAL NOT NULL,
  funding_drag_pct REAL NOT NULL DEFAULT 0,
  bars_held INTEGER NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, exchange, symbol, timeframe, entry_time, side)
);

CREATE TABLE IF NOT EXISTS orders_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_order_id TEXT NOT NULL UNIQUE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL,
  order_type TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL,
  qty REAL NOT NULL,
  reduce_only INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  exchange_order_id TEXT,
  payload_json TEXT,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS equity_curve (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  time INTEGER NOT NULL,
  equity REAL NOT NULL,
  drawdown_pct REAL NOT NULL,
  open_lev REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, exchange, symbol, timeframe, time)
);
`;

export class StandaloneStore {
  constructor({ dbPath, allowedBaseDir } = {}) {
    this.dbPath = resolveSafeSqlitePath(dbPath, allowedBaseDir);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA_SQL);
  }

  getJournalMode() {
    const row = this.db.prepare('PRAGMA journal_mode;').get();
    return row ? String(row.journal_mode).toLowerCase() : '';
  }

  runTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const res = fn();
      this.db.exec('COMMIT;');
      return res;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  upsertCandles({ exchange, symbol, timeframe, rows }) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO candles (exchange, symbol, timeframe, time, open, high, low, close, volume, closed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (exchange, symbol, timeframe, time) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        closed = excluded.closed,
        updated_at = excluded.updated_at
    `);
    return this.runTransaction(() => {
      let count = 0;
      for (const r of rows) {
        stmt.run(exchange, symbol, timeframe, r.time, r.open, r.high, r.low, r.close, r.volume ?? 0, 1, now);
        count++;
      }
      return count;
    });
  }

  getCandles({ exchange, symbol, timeframe, limit = 1000 } = {}) {
    const stmt = this.db.prepare(`
      SELECT time, open, high, low, close, volume
      FROM candles
      WHERE exchange = ? AND symbol = ? AND timeframe = ?
      ORDER BY time DESC
      LIMIT ?
    `);
    const rows = stmt.all(exchange, symbol, timeframe, limit);
    return rows.reverse().map(r => ({
      time: Number(r.time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
  }

  upsertFundingRates({ exchange, symbol, rows }) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO funding_rates (exchange, symbol, time, funding_rate, realized_rate, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (exchange, symbol, time) DO UPDATE SET
        funding_rate = excluded.funding_rate,
        realized_rate = excluded.realized_rate,
        updated_at = excluded.updated_at
    `);
    return this.runTransaction(() => {
      let count = 0;
      for (const r of rows) {
        stmt.run(exchange, symbol, r.time, r.fundingRate, r.realizedRate ?? r.fundingRate, now);
        count++;
      }
      return count;
    });
  }

  getFundingRates({ exchange, symbol, limit = 1000 } = {}) {
    const stmt = this.db.prepare(`
      SELECT time, funding_rate, realized_rate
      FROM funding_rates
      WHERE exchange = ? AND symbol = ?
      ORDER BY time DESC
      LIMIT ?
    `);
    return stmt.all(exchange, symbol, limit).reverse().map(r => ({
      time: Number(r.time),
      fundingRate: Number(r.funding_rate),
      realizedRate: Number(r.realized_rate),
    }));
  }

  upsertSignalsAudit(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO signals_audit (
        exchange, symbol, timeframe, bar_time, bar_index, side, limit_price, atr,
        prob_win, model_version, decision, size_mult, features_json, meta_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (exchange, symbol, timeframe, bar_time, side) DO UPDATE SET
        prob_win = excluded.prob_win,
        model_version = excluded.model_version,
        decision = excluded.decision,
        size_mult = excluded.size_mult,
        features_json = excluded.features_json,
        meta_json = excluded.meta_json
    `);
    return this.runTransaction(() => {
      let count = 0;
      for (const s of records) {
        stmt.run(
          s.exchange,
          s.symbol,
          s.timeframe,
          s.barTime,
          s.barIndex,
          s.side,
          s.limitPrice ?? null,
          s.atr ?? null,
          s.probWin ?? null,
          s.modelVersion ?? null,
          s.decision,
          s.sizeMult ?? 1.0,
          s.features ? JSON.stringify(s.features) : null,
          s.meta ? JSON.stringify(s.meta) : null,
          now,
        );
        count++;
      }
      return count;
    });
  }

  getSignalsAudit({ exchange, symbol, timeframe, limit = 100 } = {}) {
    const stmt = this.db.prepare(`
      SELECT id, exchange, symbol, timeframe, bar_time, bar_index, side, limit_price, atr,
             prob_win, model_version, decision, size_mult, features_json, meta_json, created_at
      FROM signals_audit
      WHERE exchange = ? AND symbol = ? AND (? IS NULL OR timeframe = ?)
      ORDER BY bar_time DESC
      LIMIT ?
    `);
    return stmt.all(exchange, symbol, timeframe ?? null, timeframe ?? null, limit).map(r => ({
      id: Number(r.id),
      exchange: r.exchange,
      symbol: r.symbol,
      timeframe: r.timeframe,
      barTime: Number(r.bar_time),
      barIndex: Number(r.bar_index),
      side: Number(r.side),
      limitPrice: r.limit_price === null ? null : Number(r.limit_price),
      atr: r.atr === null ? null : Number(r.atr),
      probWin: r.prob_win === null ? null : Number(r.prob_win),
      modelVersion: r.model_version,
      decision: r.decision,
      sizeMult: Number(r.size_mult),
      features: r.features_json ? JSON.parse(r.features_json) : null,
      meta: r.meta_json ? JSON.parse(r.meta_json) : null,
      createdAt: Number(r.created_at),
    }));
  }

  savePaperState(id, stateObj) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO paper_state (id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(id, JSON.stringify(stateObj), now);
    return { id, updatedAt: now };
  }

  loadPaperState(id) {
    const row = this.db.prepare('SELECT state_json, updated_at FROM paper_state WHERE id = ?').get(id);
    if (!row) return null;
    return {
      state: JSON.parse(row.state_json),
      updatedAt: Number(row.updated_at),
    };
  }

  upsertTrades({ runId, exchange, symbol, timeframe, trades }) {
    if (!Array.isArray(trades) || trades.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO trades_history (
        run_id, exchange, symbol, timeframe, side, entry_time, exit_time,
        entry_price, exit_price, stop_price, target_price, lev, prob_win,
        exit_reason, gross_pct, net_pct, funding_drag_pct, bars_held, meta_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, exchange, symbol, timeframe, entry_time, side) DO UPDATE SET
        exit_time = excluded.exit_time,
        exit_price = excluded.exit_price,
        exit_reason = excluded.exit_reason,
        gross_pct = excluded.gross_pct,
        net_pct = excluded.net_pct,
        funding_drag_pct = excluded.funding_drag_pct,
        bars_held = excluded.bars_held,
        meta_json = excluded.meta_json
    `);
    return this.runTransaction(() => {
      let count = 0;
      for (const t of trades) {
        stmt.run(
          runId,
          exchange,
          symbol,
          timeframe,
          t.side,
          t.entryTime,
          t.exitTime,
          t.entry,
          t.exit,
          t.stop,
          t.target,
          t.lev ?? 1.0,
          t.probWin ?? null,
          t.exitReason,
          t.grossPct,
          t.netPct,
          t.fundingDragPct ?? 0,
          t.barsHeld ?? 0,
          t.meta ? JSON.stringify(t.meta) : null,
          now,
        );
        count++;
      }
      return count;
    });
  }

  getTradesHistory({ runId, exchange, symbol, timeframe, limit = 250 } = {}) {
    const stmt = this.db.prepare(`
      SELECT id, run_id, exchange, symbol, timeframe, side, entry_time, exit_time,
             entry_price, exit_price, stop_price, target_price, lev, prob_win,
             exit_reason, gross_pct, net_pct, funding_drag_pct, bars_held, meta_json
      FROM trades_history
      WHERE (? IS NULL OR run_id = ?)
        AND (? IS NULL OR exchange = ?)
        AND (? IS NULL OR symbol = ?)
        AND (? IS NULL OR timeframe = ?)
      ORDER BY entry_time DESC
      LIMIT ?
    `);
    return stmt.all(
      runId ?? null, runId ?? null,
      exchange ?? null, exchange ?? null,
      symbol ?? null, symbol ?? null,
      timeframe ?? null, timeframe ?? null,
      limit,
    ).map(r => ({
      id: Number(r.id),
      runId: r.run_id,
      exchange: r.exchange,
      symbol: r.symbol,
      timeframe: r.timeframe,
      side: Number(r.side),
      entryTime: Number(r.entry_time),
      exitTime: Number(r.exit_time),
      entry: Number(r.entry_price),
      exit: Number(r.exit_price),
      stop: Number(r.stop_price),
      target: Number(r.target_price),
      lev: Number(r.lev),
      probWin: r.prob_win === null ? null : Number(r.prob_win),
      exitReason: r.exit_reason,
      grossPct: Number(r.gross_pct),
      netPct: Number(r.net_pct),
      fundingDragPct: Number(r.funding_drag_pct),
      barsHeld: Number(r.bars_held),
      meta: r.meta_json ? JSON.parse(r.meta_json) : null,
    }));
  }

  upsertOrderLog(order) {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO orders_log (
        client_order_id, exchange, symbol, mode, order_type, side, price, qty,
        reduce_only, status, exchange_order_id, payload_json, response_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (client_order_id) DO UPDATE SET
        status = excluded.status,
        exchange_order_id = COALESCE(excluded.exchange_order_id, orders_log.exchange_order_id),
        response_json = COALESCE(excluded.response_json, orders_log.response_json),
        updated_at = excluded.updated_at
    `);
    stmt.run(
      order.clientOrderId,
      order.exchange,
      order.symbol,
      order.mode,
      order.orderType,
      order.side,
      order.price ?? null,
      order.qty,
      order.reduceOnly ? 1 : 0,
      order.status,
      order.exchangeOrderId ?? null,
      order.payload ? JSON.stringify(order.payload) : null,
      order.response ? JSON.stringify(order.response) : null,
      now,
      now,
    );
  }

  getOrdersLog({ symbol, limit = 100 } = {}) {
    const stmt = this.db.prepare(`
      SELECT client_order_id, exchange, symbol, mode, order_type, side, price, qty,
             reduce_only, status, exchange_order_id, payload_json, response_json, created_at, updated_at
      FROM orders_log
      WHERE (? IS NULL OR symbol = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(symbol ?? null, symbol ?? null, limit).map(r => ({
      clientOrderId: r.client_order_id,
      exchange: r.exchange,
      symbol: r.symbol,
      mode: r.mode,
      orderType: r.order_type,
      side: r.side,
      price: r.price === null ? null : Number(r.price),
      qty: Number(r.qty),
      reduceOnly: Boolean(r.reduce_only),
      status: r.status,
      exchangeOrderId: r.exchange_order_id,
      payload: r.payload_json ? JSON.parse(r.payload_json) : null,
      response: r.response_json ? JSON.parse(r.response_json) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  recoverInterruptedOrders() {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      UPDATE orders_log
      SET status = 'INTERRUPTED', updated_at = ?
      WHERE status IN ('SUBMITTING', 'PENDING_ACK')
    `);
    const info = stmt.run(now);
    return Number(info.changes || 0);
  }

  upsertEquityCurve({ runId, exchange, symbol, timeframe, points }) {
    if (!Array.isArray(points) || points.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT INTO equity_curve (run_id, exchange, symbol, timeframe, time, equity, drawdown_pct, open_lev, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, exchange, symbol, timeframe, time) DO UPDATE SET
        equity = excluded.equity,
        drawdown_pct = excluded.drawdown_pct,
        open_lev = excluded.open_lev
    `);
    return this.runTransaction(() => {
      let count = 0;
      for (const p of points) {
        stmt.run(runId, exchange, symbol, timeframe, p.time, p.equity, p.drawdownPct ?? 0, p.openLev ?? 0, now);
        count++;
      }
      return count;
    });
  }

  getEquityCurve({ runId, exchange, symbol, timeframe, limit = 500 } = {}) {
    const stmt = this.db.prepare(`
      SELECT time, equity, drawdown_pct, open_lev
      FROM equity_curve
      WHERE run_id = ? AND exchange = ? AND symbol = ? AND timeframe = ?
      ORDER BY time DESC
      LIMIT ?
    `);
    return stmt.all(runId, exchange, symbol, timeframe, limit).reverse().map(r => ({
      time: Number(r.time),
      equity: Number(r.equity),
      drawdownPct: Number(r.drawdown_pct),
      openLev: Number(r.open_lev),
    }));
  }

  close() {
    this.db.close();
  }
}
