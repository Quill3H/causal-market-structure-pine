# CHoCH + Source RVOL Arrows Design

## Intent

Make the default BUY/SELL signal appear on the closed candle that confirms a CHoCH, provided the OB source candle has enough relative volume. This gives an earlier, simpler signal that the user can evaluate on BTCUSDT 15m.

## Selected approach

Use a new default mode, `CHoCH + Source RVOL`. BUY requires a confirmed bullish CHoCH and source RVOL >= 1.2; SELL is symmetric. Source RVOL uses a fixed baseline of the 20 candles preceding the OB source candle, independent of the configurable legacy-mode volume baseline. Missing or zero-baseline source volume blocks the signal. Keep `Balanced` and `Strict` as selectable legacy modes so the current behavior remains recoverable without reverting code.

## Display and naming

Draw the arrow on the CHoCH confirmation candle, once per CHoCH event. Rename the zone metric from `Source V` to `OB Source Vol` and show its source RVOL alongside the absolute volume. The absolute value is exchange volume for the source candle; RVOL is the value used by the new signal.

## Constraints

- Signals only occur after candle close and do not repaint onto an earlier candle.
- No OB retest, FVG, Mapping, sweep or confirmation-candle volume is required in the new mode.
- The 1.2 threshold is configurable and is not a probability or proven accuracy improvement.
- Existing structure, OB/FVG drawings, legacy modes, and original v5 source remain available.

## Alternatives considered

- CHoCH plus absolute source volume: rejected because absolute volume is not comparable across symbols or timeframes.
- Wait for a later OB retest: more selective but conflicts with the selected early-signal behavior.
- Remove legacy modes: simpler UI but makes comparison and rollback harder.
