"""Build focused Pine checks for closed-candle CHoCH + source RVOL arrows."""
from pathlib import Path

from build_regression import declaration


root = Path(__file__).resolve().parents[1]
source = (root / "TOOL.pine").read_text(encoding="utf-8")
helper = declaration(source, "chochSourceSignal")
event_helper = declaration(source, "structureEventDirection")

output = "\n".join(source.splitlines()[:2]) + """
//@version=6
indicator("CHoCH source RVOL regression", overlay = true)
""" + helper + event_helper + """
check(bool ok, string message) =>
    if not ok
        runtime.error(message)
    true

if barstate.islastconfirmedhistory
    check(chochSourceSignal(true, true, 1.2, 1.2), "threshold equality must signal")
    check(not chochSourceSignal(false, true, 2.0, 1.2), "unfinished candle must not signal")
    check(not chochSourceSignal(true, false, 2.0, 1.2), "BOS or no CHoCH must not signal")
    check(not chochSourceSignal(true, true, 1.19, 1.2), "below-threshold source RVOL must not signal")
    check(not chochSourceSignal(true, true, na, 1.2), "missing source RVOL must not signal")
    check(structureEventDirection("choch", 1) == 1, "initial bullish CHoCH must remain bullish")
    check(structureEventDirection("choch", -1) == -1, "initial bearish CHoCH must remain bearish")
    check(structureEventDirection("choch", 1) != -1, "bullish reversal must not leak into sell")
    check(structureEventDirection("choch", -1) != 1, "bearish reversal must not leak into buy")
    check(structureEventDirection("bos", 1) == 0, "bullish BOS must not become a CHoCH signal")
    check(structureEventDirection("bos", -1) == 0, "bearish BOS must not become a CHoCH signal")
    bool buy = chochSourceSignal(true, true, 1.3, 1.2)
    bool sell = chochSourceSignal(true, false, 1.3, 1.2)
    check(buy and not sell, "bullish and bearish event inputs must remain isolated")
    label.new(bar_index, high, "CHOCH RVOL PASS", color = color.green)
plot(na)
"""

target = root / "tests" / "regression-choch-signals.pine"
target.write_bytes(output.encode("utf-8"))
print(target)
