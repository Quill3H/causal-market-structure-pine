# Confirmed arrow implementation

Spec: ../specs/2026-11-04-confirmed-arrows-design.md. User approved both directions and confluence. Execute natively in the existing isolated folder.

- [x] Build Pine fixtures from actual production helpers: bullish/bearish rejection, failed confluence, incomplete candle, insufficient/missing volume, same-bar creation, invalidation, duplicate and conflicting signals. Observe the feature missing before implementing.
- [x] Add OB source RVOL and per-zone consumption; expose structure OB arrays and FVG arrays/raid timestamps without duplicating stateful calls. Calculate Mapping and FVG independently of their drawing toggles.
- [x] Add configurable closed-candle confluence, plot arrows on the confirmation candle, and test all paths. No probability or target-price claim.
- [x] Compile and execute on TradingView; run existing lifecycle regressions. Record source hashes, update README and the existing GitHub PR. Preserve original TOOL and restore the chart test session.
