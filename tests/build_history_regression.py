"""Exercise production history searches against a rising synthetic price series."""
from pathlib import Path
from build_regression import declaration, schema

root = Path(__file__).resolve().parents[1]
source = (root / 'TOOL.pine').read_text(encoding='utf-8')
script = '\n'.join(source.splitlines()[:2]) + '\n' + '''//@version=6
indicator("SMC history regression", max_bars_back = 5000)
const int HISTORY_LIMIT = 4500
// Synthetic monotonic prices force a minimum anchor to become very old.
float high = 110.0 + bar_index
float low = 100.0 + bar_index
'''
script += schema(source, 'structure')
for name in ('historyOffset', 'IDMIDX', 'find'):
    script += declaration(source, name)
script += '''
var structure anchor = structure.new(loc = 0, xloc = 0)
int lowOffset = anchor.find(false, false, true)
int highOffset = anchor.find(true, false, true)
int mappedOffset = IDMIDX(false, 0)
if barstate.islastconfirmedhistory
    if bar_index <= HISTORY_LIMIT
        runtime.error("Load more than 4500 bars to exercise history bounds")
    if lowOffset != 4500 or mappedOffset != 4500 or highOffset != 0
        runtime.error("History search did not preserve extrema within its bounded range")
    label.new(bar_index, lowOffset, "HISTORY PASS")
plot(lowOffset, "Bounded minimum offset")
'''
out = root / 'tests' / 'regression-history.pine'
out.write_text(script, encoding='utf-8')
print(out)
