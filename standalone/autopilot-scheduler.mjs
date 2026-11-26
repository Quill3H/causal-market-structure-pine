import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { scrubSecrets } from './config.mjs';
import { isEquitySymbol } from './market_equities.mjs';
import { COMMERCIAL_PLANS } from './license_issuer.mjs';

function clampIntervalSec(value, fallback = 60) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5, Math.min(3600, Math.trunc(n)));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function maskProfileEmail(email) {
  if (!email || typeof email !== 'string') return email ?? null;
  const trimmed = email.trim();
  if (!trimmed || trimmed === 'paper-sandbox@local') return trimmed;
  const atIdx = trimmed.indexOf('@');
  if (atIdx <= 0) {
    return `${trimmed.slice(0, 2)}***`;
  }
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  const prefix = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${prefix}***@${domain}`;
}

/**
 * Continuous Background Autopilot Scheduler (v11.0).
 * Keeps armingPin leases strictly in private RAM (#leases) and persists only
 * non-secret session metadata and audit events in SQLite WAL.
 */
export class AutopilotScheduler {
  #leases = new Map();
  #inFlight = new Set();
  #timer = null;

  constructor({ config, store, commercialStore = null, commercialEngine, daemon = null, intervalSec = null } = {}) {
    assert.ok(config, 'Config is required for AutopilotScheduler');
    assert.ok(store, 'StandaloneStore is required for AutopilotScheduler');
    assert.ok(commercialEngine, 'CommercialPlatformEngine is required for AutopilotScheduler');

    this.config = config;
    this.store = store;
    this.cStore = commercialStore || commercialEngine.cStore;
    this.commercialEngine = commercialEngine;
    this.daemon = daemon;
    this.defaultIntervalSec = clampIntervalSec(intervalSec ?? config.autopilotIntervalSec ?? 60);
    this._running = false;

    this.cStore.recoverInterruptedAutopilotSessions();
  }

  toJSON() {
    return this.getStatus({ includeLocalProfiles: false });
  }

  isArmed(subscriberId) {
    if (!subscriberId) return false;
    const session = this.cStore.getAutopilotSession(subscriberId);
    return this.#leases.has(subscriberId) && session?.state === 'ARMED_RUNNING';
  }

  async armSubscriber({
    subscriberId,
    armingPin,
    executionMode = null,
    timeframe = '1h',
    intervalSec = null,
    clientOverride = null,
    overlayOverrides = null,
    simulatedEquityUsdt = null,
    runImmediately = true,
  } = {}) {
    assert.ok(subscriberId, 'subscriberId is required');
    const sub = this.cStore.getSubscriberById(subscriberId);
    if (!sub || sub.status !== 'ACTIVE') {
      throw new Error('SECURITY BLOCK: Subscriber not found or inactive');
    }

    let nextMode = executionMode ? String(executionMode).trim().toUpperCase() : sub.execution_mode;
    if (!executionMode && nextMode === 'SCAN_AND_SIGNAL_ONLY') {
      nextMode = sub.is_paper_sandbox ? 'PAPER_AUTO_TRADE' : (sub.simulated ? 'DEMO_AUTO_TRADE' : 'LIVE_AUTO_TRADE');
    }

    const isZeroPinSandbox = Boolean(sub.is_paper_sandbox) && nextMode === 'PAPER_AUTO_TRADE' && !sub.arming_pin_hash;
    if (!isZeroPinSandbox && !this.commercialEngine.verifySubscriberPin(subscriberId, armingPin)) {
      throw new Error('SECURITY BLOCK: Invalid armingPin');
    }

    this.commercialEngine.updateSubscriberMode(subscriberId, {
      executionMode: nextMode,
      armingPin: typeof armingPin === 'string' ? armingPin.trim() : '',
    });

    const effIntervalSec = clampIntervalSec(intervalSec ?? this.defaultIntervalSec, this.defaultIntervalSec);
    const tf = String(timeframe || '1h').trim().toLowerCase();
    const now = Date.now();

    this.#leases.set(subscriberId, {
      armingPin: typeof armingPin === 'string' ? armingPin.trim() : '',
      timeframe: tf,
      intervalSec: effIntervalSec,
      clientOverride,
      overlayOverrides,
      armedAt: now,
    });

    const curSession = this.cStore.getAutopilotSession(subscriberId);
    this.cStore.upsertAutopilotSession({
      subscriberId,
      state: 'ARMED_RUNNING',
      intervalSec: effIntervalSec,
      timeframe: tf,
      executionMode: nextMode,
      cycleCount: curSession?.cycle_count ?? 0,
      nextTickAt: now + effIntervalSec * 1000,
      armedAt: now,
      disarmedAt: null,
      disarmReason: null,
      lastError: null,
    });

    this.cStore.insertAutopilotEvent({
      subscriberId,
      eventType: 'ARMED',
      level: 'INFO',
      message: `Autopilot armed in ${nextMode} (${effIntervalSec}s interval, ${tf})`,
      details: { executionMode: nextMode, intervalSec: effIntervalSec, timeframe: tf },
      createdAt: now,
    });

    let initialTick = null;
    if (runImmediately) {
      initialTick = await this.tickSubscriber(subscriberId, {
        simulatedEquityUsdt,
        clientOverride,
        overlayOverrides,
      });
    }

    if (!this._running) {
      this.start();
    }

    return {
      armed: this.isArmed(subscriberId),
      session: this.cStore.getAutopilotSession(subscriberId),
      lastTick: initialTick,
    };
  }

  async disarmSubscriber(subscriberId, {
    reason = 'MANUAL_PAUSE',
    cancelPendingEntries = false,
    clientOverride = null,
  } = {}) {
    assert.ok(subscriberId, 'subscriberId is required');
    const lease = this.#leases.get(subscriberId) || null;
    this.#leases.delete(subscriberId);

    const sub = this.cStore.getSubscriberById(subscriberId);
    const cancelledOrders = [];

    if (cancelPendingEntries && sub) {
      const credRow = this.cStore.getEncryptedCredentials(subscriberId);
      const effectiveClient = clientOverride || lease?.clientOverride || (credRow?.envelope
        ? this.commercialEngine._buildTenantExchangeClient({
            subscriberId,
            exchange: sub.exchange,
            simulated: sub.execution_mode !== 'LIVE_AUTO_TRADE',
            creds: this.commercialEngine._decryptTenantCreds(subscriberId, credRow, {
              forLiveAutoTrade: sub.execution_mode === 'LIVE_AUTO_TRADE',
            }),
            executionMode: sub.execution_mode,
            maxLeverageCap: sub.max_leverage_cap,
            maxOrderUsdt: COMMERCIAL_PLANS[sub.plan_id]?.maxCapitalUsdt ?? 25000,
          })
        : (sub.is_paper_sandbox
            ? this.commercialEngine._buildPaperSandboxClient({ subscriberId, exchange: sub.exchange })
            : null));

      const pendingEntries = this.cStore
        .getSubscriberOrdersLog({ subscriberId, limit: 100 })
        .filter(o => !o.reduceOnly && ['post_only', 'LIMIT_GTX'].includes(o.order_type) && o.status === 'SUBMITTED');

      const confirmTok = this.config.liveConfirmToken || `tenant_${subscriberId}`;
      for (const ord of pendingEntries) {
        if (!effectiveClient || typeof effectiveClient.cancelOrder !== 'function') continue;
        const cancelId = `t10${sha256Hex(`${ord.client_order_id}|MANUAL_C|${Date.now()}`).slice(0, 29)}`;
        try {
          const cRes = sub.exchange === 'OKX'
            ? await effectiveClient.cancelOrder({ symbol: ord.symbol, clOrdId: ord.client_order_id }, { confirmToken: confirmTok })
            : await effectiveClient.cancelOrder({ symbol: ord.symbol, origClientOrderId: ord.client_order_id }, { confirmToken: confirmTok });

          this.cStore.upsertSubscriberOrderLog({
            clientOrderId: cancelId,
            subscriberId,
            exchange: sub.exchange,
            symbol: ord.symbol,
            mode: sub.execution_mode,
            orderType: 'CANCEL',
            side: ord.side === 'buy' ? 'sell' : 'buy',
            price: ord.price,
            qty: ord.qty,
            reduceOnly: false,
            status: 'CANCELLED',
            payload: { origClOrdId: ord.client_order_id, reason },
            response: cRes,
          });
          this.cStore.upsertSubscriberOrderLog({
            clientOrderId: ord.client_order_id,
            subscriberId,
            exchange: sub.exchange,
            symbol: ord.symbol,
            mode: sub.execution_mode,
            orderType: ord.order_type,
            side: ord.side,
            price: ord.price,
            qty: ord.qty,
            reduceOnly: false,
            status: 'CANCELLED',
          });
          const childOrders = this.cStore
            .getSubscriberOrdersLog({ subscriberId, limit: 100 })
            .filter(o =>
              o.reduceOnly
              && ['PENDING_FILL_WATCH', 'ATTACHED_TO_ENTRY'].includes(o.status)
              && o.payload?.parentEntryClOrdId === ord.client_order_id
            );
          for (const child of childOrders) {
            this.cStore.upsertSubscriberOrderLog({
              clientOrderId: child.client_order_id,
              subscriberId,
              exchange: sub.exchange,
              symbol: child.symbol,
              mode: sub.execution_mode,
              orderType: child.order_type,
              side: child.side,
              price: child.price,
              qty: child.qty,
              reduceOnly: true,
              status: 'CANCELLED',
            });
          }
          cancelledOrders.push({ clientOrderId: ord.client_order_id, symbol: ord.symbol });
        } catch (err) {
          const safeErr = scrubSecrets(err.message, this.config);
          this.cStore.upsertSubscriberOrderLog({
            clientOrderId: cancelId,
            subscriberId,
            exchange: sub.exchange,
            symbol: ord.symbol,
            mode: sub.execution_mode,
            orderType: 'CANCEL',
            side: ord.side === 'buy' ? 'sell' : 'buy',
            price: ord.price,
            qty: ord.qty,
            reduceOnly: false,
            status: 'REJECTED',
            payload: { origClOrdId: ord.client_order_id, reason },
            response: { error: safeErr },
          });
        }
      }
    }

    const now = Date.now();
    const curSession = this.cStore.getAutopilotSession(subscriberId);
    const session = this.cStore.upsertAutopilotSession({
      subscriberId,
      state: 'DISARMED',
      intervalSec: curSession?.interval_sec ?? lease?.intervalSec ?? this.defaultIntervalSec,
      timeframe: curSession?.timeframe ?? lease?.timeframe ?? '1h',
      executionMode: sub?.execution_mode ?? curSession?.execution_mode ?? 'SCAN_AND_SIGNAL_ONLY',
      nextTickAt: null,
      disarmedAt: now,
      disarmReason: reason,
    });

    this.cStore.insertAutopilotEvent({
      subscriberId,
      eventType: 'DISARMED',
      level: 'INFO',
      message: `Autopilot disarmed (${reason})`,
      details: { reason, cancelPendingEntries: Boolean(cancelPendingEntries), cancelledCount: cancelledOrders.length },
      createdAt: now,
    });

    return {
      disarmed: true,
      session,
      cancelledOrders,
    };
  }

  async _syncMarketDataNonFatal(sub, timeframe) {
    if (!this.daemon || typeof this.daemon.syncMarketData !== 'function') return;
    const plan = COMMERCIAL_PLANS[sub.plan_id];
    const symbols = (plan?.allowedSymbols || this.config.symbols || ['BTCUSDT.P'])
      .filter(s => !isEquitySymbol(s));
    for (const symbol of symbols) {
      try {
        await this.daemon.syncMarketData({ symbol, timeframe, bars: 300 });
      } catch {
        // Non-fatal: continue with cached SQLite or local 5Y dataset
      }
    }
  }

  async tickSubscriber(subscriberId, {
    simulatedEquityUsdt = null,
    availableMarginUsdt = null,
    clientOverride = null,
    overlayOverrides = null,
  } = {}) {
    if (!subscriberId) return { ticked: false, skipped: true, reason: 'MISSING_SUBSCRIBER' };
    if (this.#inFlight.has(subscriberId)) {
      return { ticked: false, skipped: true, reason: 'IN_FLIGHT' };
    }
    const lease = this.#leases.get(subscriberId);
    if (!lease) {
      return { ticked: false, skipped: true, reason: 'NOT_ARMED' };
    }

    const sub = this.cStore.getSubscriberById(subscriberId);
    if (!sub || sub.status !== 'ACTIVE') {
      this.#leases.delete(subscriberId);
      return { ticked: false, skipped: true, reason: 'INACTIVE_SUBSCRIBER' };
    }

    this.#inFlight.add(subscriberId);
    try {
      await this._syncMarketDataNonFatal(sub, lease.timeframe);
      if (!this.#leases.has(subscriberId) || !this.cStore.getSubscriberById(subscriberId)) {
        return { ticked: false, skipped: true, reason: 'DISARMED_DURING_TICK' };
      }

      const cycleRes = await this.commercialEngine.runSubscriberAutoTradeCycle(subscriberId, {
        armingPin: lease.armingPin,
        simulatedEquityUsdt,
        availableMarginUsdt,
        clientOverride: clientOverride ?? lease.clientOverride ?? null,
        timeframe: lease.timeframe,
        overlayOverrides: overlayOverrides ?? lease.overlayOverrides ?? null,
      });

      if (!this.#leases.has(subscriberId) || !this.cStore.getSubscriberById(subscriberId)) {
        return { ticked: false, skipped: true, reason: 'DISARMED_DURING_TICK' };
      }

      const now = Date.now();
      const cur = this.cStore.getAutopilotSession(subscriberId);
      const nextCycleCount = Number(cur?.cycle_count ?? 0) + 1;
      const blockedReason = cycleRes.blockedReason || null;
      const isFatalGuardrail = Boolean(blockedReason && /^GUARDRAIL_[1-5]_/.test(blockedReason));

      if (isFatalGuardrail) {
        this.#leases.delete(subscriberId);
        const trippedSession = this.cStore.upsertAutopilotSession({
          subscriberId,
          state: 'TRIPPED',
          intervalSec: lease.intervalSec,
          timeframe: lease.timeframe,
          executionMode: sub.execution_mode,
          cycleCount: nextCycleCount,
          lastTickAt: now,
          nextTickAt: null,
          lastCycleStatus: blockedReason,
          lastError: blockedReason,
          disarmedAt: now,
          disarmReason: blockedReason,
        });
        this.cStore.insertAutopilotEvent({
          subscriberId,
          eventType: 'GUARDRAIL_TRIP',
          level: 'WARN',
          message: `Autopilot auto-disarmed by ${blockedReason}`,
          details: { blockedReason, riskState: cycleRes.riskState ?? null },
          createdAt: now,
        });
        return {
          ...cycleRes,
          ticked: true,
          autoDisarmed: true,
          session: trippedSession,
        };
      }

      const cycleStatus = cycleRes.executed
        ? 'EXECUTED'
        : (blockedReason || cycleRes.action || 'OK');
      const updatedSession = this.cStore.upsertAutopilotSession({
        subscriberId,
        state: 'ARMED_RUNNING',
        intervalSec: lease.intervalSec,
        timeframe: lease.timeframe,
        executionMode: sub.execution_mode,
        cycleCount: nextCycleCount,
        lastTickAt: now,
        nextTickAt: now + lease.intervalSec * 1000,
        lastCycleStatus: cycleStatus,
        lastError: blockedReason,
      });
      this.cStore.insertAutopilotEvent({
        subscriberId,
        eventType: 'TICK',
        level: 'INFO',
        message: `Cycle #${nextCycleCount}: ${cycleStatus}`,
        details: {
          cycleCount: nextCycleCount,
          executed: Boolean(cycleRes.executed),
          actionsCount: Array.isArray(cycleRes.actions) ? cycleRes.actions.length : 0,
          blockedReason,
        },
        createdAt: now,
      });
      return {
        ...cycleRes,
        ticked: true,
        autoDisarmed: false,
        session: updatedSession,
      };
    } catch (err) {
      if (!this.#leases.has(subscriberId) || !this.cStore.getSubscriberById(subscriberId)) {
        return { ticked: false, skipped: true, reason: 'DISARMED_DURING_TICK' };
      }
      const now = Date.now();
      const safeErr = scrubSecrets(err.message, this.config);
      const cur = this.cStore.getAutopilotSession(subscriberId);
      const nextCycleCount = Number(cur?.cycle_count ?? 0) + 1;
      const updatedSession = this.cStore.upsertAutopilotSession({
        subscriberId,
        state: 'ARMED_RUNNING',
        intervalSec: lease.intervalSec,
        timeframe: lease.timeframe,
        executionMode: sub.execution_mode,
        cycleCount: nextCycleCount,
        lastTickAt: now,
        nextTickAt: now + lease.intervalSec * 1000,
        lastCycleStatus: 'ERROR',
        lastError: safeErr,
      });
      this.cStore.insertAutopilotEvent({
        subscriberId,
        eventType: 'ERROR',
        level: 'ERROR',
        message: safeErr,
        details: { cycleCount: nextCycleCount },
        createdAt: now,
      });
      return {
        executed: false,
        ticked: false,
        error: safeErr,
        session: updatedSession,
      };
    } finally {
      this.#inFlight.delete(subscriberId);
    }
  }

  async tickDueSubscribers() {
    const dueIds = [];
    const now = Date.now();
    for (const subscriberId of this.#leases.keys()) {
      if (this.#inFlight.has(subscriberId)) continue;
      const session = this.cStore.getAutopilotSession(subscriberId);
      if (!session || session.state !== 'ARMED_RUNNING') continue;
      if (session.next_tick_at && now < Number(session.next_tick_at)) continue;
      dueIds.push(subscriberId);
    }
    const results = [];
    for (const subscriberId of dueIds) {
      results.push(await this.tickSubscriber(subscriberId));
    }
    return results;
  }

  start(pollMs = 1000) {
    if (this._running) return;
    this._running = true;
    const effPollMs = Math.max(50, Math.min(5000, Number(pollMs) || 1000));
    this.#timer = setInterval(() => {
      this.tickDueSubscribers().catch(() => {});
    }, effPollMs);
    this.#timer.unref?.();
  }

  stop() {
    this._running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  updateLeaseSchedule(subscriberId, { intervalSec = null, timeframe = null } = {}) {
    if (!subscriberId) return null;
    const curSession = this.cStore.getAutopilotSession(subscriberId);
    const lease = this.#leases.get(subscriberId);
    const nextIntervalSec = intervalSec !== null && intervalSec !== undefined
      ? clampIntervalSec(intervalSec, this.defaultIntervalSec)
      : (lease?.intervalSec ?? curSession?.interval_sec ?? this.defaultIntervalSec);
    const nextTf = timeframe
      ? String(timeframe).trim().toLowerCase()
      : (lease?.timeframe ?? curSession?.timeframe ?? '1h');

    if (lease) {
      lease.intervalSec = nextIntervalSec;
      lease.timeframe = nextTf;
    }
    if (curSession) {
      return this.cStore.upsertAutopilotSession({
        subscriberId,
        intervalSec: nextIntervalSec,
        timeframe: nextTf,
        nextTickAt: curSession.state === 'ARMED_RUNNING' ? Date.now() + nextIntervalSec * 1000 : curSession.next_tick_at,
      });
    }
    return null;
  }

  getStatus({ subscriberId = null, includeLocalProfiles = false } = {}) {
    const localQuickstart = Boolean(this.config.localQuickstartEnabled ?? true);
    const allSessions = this.cStore.listAutopilotSessions(100);
    const sessionBySub = new Map(allSessions.map(s => [s.subscriber_id, s]));
    const scopedSessions = subscriberId
      ? allSessions.filter(s => s.subscriber_id === subscriberId)
      : [];

    let savedProfiles = undefined;
    if (includeLocalProfiles) {
      if (!subscriberId && !localQuickstart) {
        savedProfiles = [];
      } else {
        const allSubs = this.cStore.listSubscribers(100);
        const visibleSubs = subscriberId
          ? (localQuickstart ? allSubs : allSubs.filter(s => s.subscriber_id === subscriberId))
          : allSubs;
        savedProfiles = visibleSubs.map(s => {
          const cred = this.cStore.getEncryptedCredentials(s.subscriber_id);
          const sess = sessionBySub.get(s.subscriber_id);
          const isSelf = Boolean(subscriberId && s.subscriber_id === subscriberId);
          return {
            subscriberId: s.subscriber_id,
            name: s.name,
            email: isSelf ? s.email : maskProfileEmail(s.email),
            exchange: s.exchange,
            simulated: Boolean(s.simulated),
            executionMode: s.execution_mode,
            preferredVersion: s.preferred_version,
            riskTier: s.risk_tier,
            keyMask: cred?.key_mask ?? null,
            hasCredentials: Boolean(cred),
            hasArmingPin: Boolean(s.arming_pin_hash),
            isPaperSandbox: Boolean(s.is_paper_sandbox),
            autopilotState: sess?.state ?? 'DISARMED',
            disarmReason: sess?.disarm_reason ?? null,
            cycleCount: sess?.cycle_count ?? 0,
            updatedAt: s.updated_at,
          };
        });
      }
    }

    const base = {
      running: this._running,
      localQuickstartEnabled: localQuickstart,
      autopilotIntervalSec: Number(this.config.autopilotIntervalSec ?? this.defaultIntervalSec),
      armedCount: this.#leases.size,
      sessions: scopedSessions,
      ...(includeLocalProfiles ? { savedProfiles } : {}),
    };

    if (!subscriberId) {
      return {
        ...base,
        subscriberId: null,
        armed: false,
        inFlight: false,
        session: null,
        countdownSec: 0,
        guardrailChecklist: [],
        events: [],
        subscriber: null,
        latestScan: null,
        scanHistory: [],
        activePositions: [],
        portfolioSummary: null,
        bracket: null,
        riskState: null,
        tickets: [],
        orders: [],
      };
    }

    const sub = this.cStore.getSubscriberById(subscriberId);
    const session = this.cStore.getAutopilotSession(subscriberId);
    const armed = this.isArmed(subscriberId);
    const dash = sub ? this.commercialEngine.getSubscriberDashboard(subscriberId) : null;
    const countdownSec = armed && session?.next_tick_at
      ? Math.max(0, Math.ceil((Number(session.next_tick_at) - Date.now()) / 1000))
      : 0;

    return {
      ...base,
      subscriberId,
      armed,
      inFlight: this.#inFlight.has(subscriberId),
      session,
      countdownSec,
      guardrailChecklist: this.commercialEngine.buildGuardrailChecklist(subscriberId, { isAutopilotArmed: armed }),
      events: this.cStore.listAutopilotEvents({ subscriberId, limit: 50 }),
      subscriber: dash?.subscriber ?? null,
      latestScan: dash?.latestScan ?? null,
      scanHistory: dash?.scanHistory ?? [],
      activePositions: dash?.activePositions ?? [],
      portfolioSummary: dash?.portfolioSummary ?? null,
      bracket: dash?.bracket ?? null,
      riskState: dash?.riskState ?? null,
      tickets: dash?.tickets ?? [],
      orders: dash?.orders ?? [],
    };
  }
}
