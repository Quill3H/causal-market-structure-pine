# Confirmed directional opportunity arrows — proposal

User request: add an arrow on a closed candle when the indicator has enough information to suggest price direction.
Status: user approved both directions and requested all existing indicator evidence be used. Native implementation is authorized.

Accepted refinement: defaults require structure and Mapping agreement, an OB rejection with an overlapping active same-direction FVG, a structural sweep or FVG raid within the last 10 bars, confirmation RVOL >= 1.2, and source-candle RVOL >= 1.0. Volume baselines use the preceding 20 candles and exclude the candle being measured. Filters are independently configurable. These thresholds are implementation choices, not calibrated accuracy claims.

## Proposed behavior

- Green upward arrow below the confirmation candle: confirmed structure trend is bullish; an existing, active bullish OB was touched by the candle's high-low range; the candle closes strictly above that OB's top; confirmation-candle volume is at least 1.2 times the mean of the previous 20 candles.
- Red downward arrow is symmetrical: bearish structure, active bearish OB touched, close strictly below the bottom, same volume condition.
- Only use OBs created on an earlier candle. No breaker is treated as a normal OB. A zone that was invalidated by the configured mitigation rule on this candle cannot trigger.
- Only evaluate and emit on a confirmed candle; plot on that candle without negative offsets. Each OB may produce at most one arrow. If both directions qualify, emit neither.
- Arrow controls are independent of OB visibility. Turning the arrow display off must not change structure/zone calculations. Default volume filtering fails closed when data or 20 previous samples are unavailable; allow the user to disable that filter explicitly.
- Default volume multiplier 1.2 and baseline 20 are proposed heuristics, not calibrated probabilities. The source-candle Source V does not enter this filter.
- Arrows indicate directional setups, not a promised next-candle move, percentage probability, or price target. No automated order or price target is added.

## Approaches

1. Structure break only: earliest and simplest, but no zone retest or volume confirmation.
2. OB retest + structure + current relative volume: proposed default; directly explains why a closed candle gets an arrow, with fewer triggers.
3. Require OB and FVG together: stricter and sparser; do not add as a mandatory rule without a user choice. Existing FVG drawings continue to provide visual context.

## Implementation scope after clarification

Modify TOOL.pine in the existing fix branch; retain the original TOOL. Add arrow settings and global plotshape outputs, and maintain per-OB signal state. Document exact conditions. Add Pine fixtures for positive, negative, unconfirmed, insufficient-volume, invalidated, same-creation-candle and duplicate-trigger cases, then compile and execute on TradingView. Existing zone lifecycle regressions must still pass.
