# CHoCH + Source RVOL Arrows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make closed-candle CHoCH plus OB source RVOL the default arrow rule while preserving legacy modes.

**Architecture:** Emit one-bar bullish/bearish CHoCH events and their source RVOL from `structure()`. A pure predicate decides whether a confirmed event clears the configurable threshold. Existing candidate logic remains available behind Balanced and Strict modes.

**Tech Stack:** TradingView Pine Script v6, Python fixture builders, TradingView compiler/runtime.

**Spec:** `docs/superpowers/specs/2026-11-07-choch-source-rvol-arrows-design.md`

## Global Constraints

- Default mode is `CHoCH + Source RVOL` with minimum source RVOL 1.2.
- CHoCH source RVOL always uses the 20 candles preceding the source candle; the legacy baseline setting must not change it.
- Arrow is plotted only on the closed CHoCH confirmation candle.
- Missing source RVOL blocks the signal.
- Preserve Balanced and Strict as selectable legacy modes.
- Rename the display metric to `OB Source Vol` and include RVOL.

## Review Focus

- Unfinished candle must not signal.
- A CHoCH event below 1.2 RVOL must not signal.
- Missing source RVOL must not signal.
- Bullish and bearish CHoCH events must not cross directions.
- BOS events must not be mistaken for CHoCH events.

---

### Task 1: Predicate and CHoCH event plumbing

**Files:**
- Modify: `TOOL.pine`
- Create: `tests/build_choch_signal_regression.py`
- Create: `tests/regression-choch-signals.pine`

**Interfaces:**
- Produces: `chochSourceSignal(bool confirmed, bool event, float sourceRvol, float minimum) -> bool`
- Produces: `structure(...) -> [structure, ob[], ob[], bool bullChoch, bool bearChoch, float bullSourceRvol, float bearSourceRvol]`

- [ ] Write a fixture that checks closed/open candles, threshold equality, below-threshold, missing RVOL, direction isolation, and BOS isolation through the production event classifier.
- [ ] Run the fixture builder/compiler and verify RED because the predicate/event outputs do not exist.
- [ ] Add the predicate and one-bar CHoCH event outputs to all four CHoCH branches.
- [ ] Run the fixture and production compiler; expect no production warnings and no runtime error.

### Task 2: Mode selection, labels, documentation and chart validation

**Files:**
- Modify: `TOOL.pine`
- Modify: `README.md`
- Create: `tests/validation-1.4.0.json`

**Interfaces:**
- Consumes: Task 1 CHoCH event outputs and predicate.
- Produces: default `CHoCH + Source RVOL` arrows, legacy mode fallback, `OB Source Vol` label.

- [ ] Add a failing source assertion for default mode, 1.2 threshold, and renamed metric.
- [ ] Select CHoCH arrows in the new mode and legacy arrows in Balanced/Strict.
- [ ] Update status text, alerts, version and README.
- [ ] Compile and run on BTCUSDT 15m; record exact returned rows and BUY/SELL counts.
- [ ] Preserve the prior chart template, apply 1.4.0 privately, reload, and verify the indicator remains healthy.
