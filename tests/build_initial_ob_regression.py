"""Run the full production indicator against a deterministic first structure break.

Generated files are local test artifacts. Each first break must request its matching
OB direction after warm-up. Calls are observed directly because derived OHLC
series history inside a conditionally called method is not a valid OHLC fixture.
"""
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
source_path = Path(sys.argv[2]) if len(sys.argv) > 2 else root / 'TOOL.pine'
source = source_path.read_text(encoding='utf-8')
direction = sys.argv[1] if len(sys.argv) > 1 else 'bull'
if direction not in ('bull', 'bear'):
    raise ValueError('expected bull or bear')
bull = direction == 'bull'
mock = '''// Synthetic OHLC fixture: unique source extreme after ATR warm-up.
float open = 101
float high = bar_index == 205 ? HIGH_EXTREME : bar_index < 211 ? 102 : BREAK_HIGH
float low = bar_index == 205 ? LOW_EXTREME : bar_index < 211 ? 100 : BREAK_LOW
float close = bar_index < 211 ? 101.5 : BREAK_CLOSE
'''
mock = mock.replace('HIGH_EXTREME', '102' if bull else '102.5')
mock = mock.replace('LOW_EXTREME', '99.5' if bull else '100')
mock = mock.replace('BREAK_HIGH', '105' if bull else '101')
mock = mock.replace('BREAK_LOW', '101' if bull else '97')
mock = mock.replace('BREAK_CLOSE', '104' if bull else '98')
source = source.replace('plot(na)', mock + '\nvar initialCalls = array.new<bool>()\nplot(na)', 1)
source = source.replace('    float top = bull ? cords : high[idx]', '    if bar_index == 211\n        initialCalls.push(bull)\n    float top = bull ? cords : high[idx]', 1)
source += f'''
if bar_index == 211 and barstate.isconfirmed
    if ms.trend != {1 if bull else -1} or initialCalls.size() != 1
        runtime.error("First {direction} break must request one OB")
    if initialCalls.get(0) != {str(bull).lower()}
        runtime.error("First {direction} break requested the wrong OB direction")
    label.new(bar_index, close, "INITIAL {direction.upper()} PASS")
'''
out = Path(sys.argv[3]) if len(sys.argv) > 3 else root / 'tests' / f'regression-initial-{direction}.pine'
out.write_bytes(source.encode('utf-8'))
print(out)
