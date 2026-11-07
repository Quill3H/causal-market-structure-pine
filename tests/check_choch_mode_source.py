"""Static contract checks for the user-facing CHoCH signal mode."""
from pathlib import Path


source = (Path(__file__).resolve().parents[1] / "TOOL.pine").read_text(encoding="utf-8")

assert "SMC Confirmed [1.4.0]" in source
assert 'input.string("CHoCH + Source RVOL", "Signal mode"' in source
assert 'input.float(1.2, "CHoCH: minimum OB source RVOL"' in source
assert "float chochVolumeBase = ta.sma(volume, 20)[1]" in source
assert '"OB Source Vol: "' in source
assert "chochSourceSignal(barstate.isconfirmed, bullChochEvent" in source
assert "chochSourceSignal(barstate.isconfirmed, bearChochEvent" in source
assert 'signalMode == "CHoCH + Source RVOL"' in source
assert source.count('structureEventType := "choch"') == 4
assert source.count('structureEventType := "bos"') == 2
assert source.count('structureEventSide := 1') == 3
assert source.count('structureEventSide := -1') == 3
assert "zone.sourceRvol" in source
assert 'signalMode == "CHoCH + Source RVOL" ? id.chochSourceRvol : id.sourceRvol' in source
print("CHoCH mode source contract passed")
