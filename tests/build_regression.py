"""Build a Pine harness using actual production functions, not Python copies.

Usage: python tests/build_regression.py [source] [Recent|Old]
Run the generated .pine in TradingView; a failed check raises runtime.error.
Only the harness shadows OHLC with deterministic fixtures.
"""
from pathlib import Path
import re
import sys


def declaration(source, name):
    pattern = rf'(?m)^(?:method )?{re.escape(name)}\([^\n]*=>[^\n]*\n'
    match = re.search(pattern, source)
    if not match:
        return ''
    end = re.search(r'(?m)^(?=\S)', source[match.end():])
    return source[match.start():match.end() + end.start()] if end else source[match.start():]


def schema(source, name):
    match = re.search(rf'(?m)^type {name}\n(?:[ \t]+[^\n]*\n|\n)+', source)
    if not match:
        raise ValueError(f'Missing type {name}')
    return match.group()


def build(source, policy):
    version = re.search(r'//@version=(\d+)', source).group(1)
    prefix = f'''//@version={version}
indicator("SMC regression {policy}", overlay = true)
// Deterministic OHLC for helper tests only.
float open = 99
float high = 106
float low = 98
float close = 105
string obmiti = "Close"
bool obshowbb = false
string wichlap = "{policy}"
string fvg_src = "Close"
string what_fvg = "FVG"
int HISTORY_LIMIT = 4500
int MAX_ZONES = 100
'''
    helpers = ''.join(declaration(source, name) for name in (
        'zonesOverlap', 'preferFirst', 'mitigationHit', 'mitigated',
        'overlap', 'overlapFVG', 'mitigateFVG', 'historyOffset',
    ))
    support = schema(source, 'ob') + schema(source, 'FVG')
    stamp = '    result.confirmedAt := stamp\n' if 'confirmedAt' in schema(source, 'ob') else ''
    stamp_fvg = '    result.confirmedAt := stamp\n' if 'confirmedAt' in schema(source, 'FVG') else ''
    fixtures = '''
testOB(float bottom, float top, int stamp, bool bull = true) =>
    result = ob.new(bull = bull, top = top, btm = bottom, avg = math.avg(top, bottom), loc = stamp, vol = 1)
''' + stamp + '''    result

testFVG(float bottom, float top, int stamp) =>
    result = FVG.new(top = top, btm = bottom, loc = stamp)
''' + stamp_fvg + '''    result

check(bool ok, string message) =>
    if not ok
        runtime.error(message)
    true

if barstate.islastconfirmedhistory
    bulls = array.new<ob>()
    bears = array.new<ob>()
    bulls.push(testOB(200, 210, 300))
    bulls.push(testOB(100, 110, 100))
    bears.push(testOB(105, 115, 200, false))
    overlap(bulls, bears)
    check(bulls.size() >= 1, "overlap removed every bull, including unrelated zone")
    check(bulls.get(0).btm == 200, "overlap deleted an unrelated zone")
'''
    fixtures += ('    check(bulls.size() == 1 and bears.size() == 1, "Recent must retain newer bear")\n'
                 if policy == 'Recent' else
                 '    check(bulls.size() == 2 and bears.size() == 0, "Old must retain older bull")\n')
    fixtures += '''
    invalid = array.new<ob>()
    invalid.push(testOB(120, 130, 100))
    invalid.push(testOB(140, 150, 200))
    invalid.mitigated()
    check(invalid.size() == 0, "consecutive invalid OBs must all be removed")

    reclaimed = array.new<ob>()
    reclaimed.push(testOB(100, 110, 100))
    reclaimed.mitigated()
    check(reclaimed.size() == 1, "Close must ignore an open below the zone")

    fvgs = array.new<FVG>()
    emptyFVG = array.new<FVG>()
    fvgs.push(testFVG(100, 110, 200))
    fvgs.push(testFVG(100, 110, 100))
    overlapFVG(fvgs, emptyFVG)
    check(fvgs.size() == 1, "identical FVG intervals must overlap")
'''
    if declaration(source, 'mitigateFVG'):
        fixtures += '''
    gaps = array.new<FVG>()
    gaps.push(testFVG(120, 130, 100))
    gaps.push(testFVG(140, 150, 200))
    gaps.mitigateFVG(true)
    check(gaps.size() == 0, "consecutive invalid FVGs must all be removed")
    gaps.push(testFVG(100, 110, 300))
    gaps.mitigateFVG(true)
    check(gaps.size() == 1, "FVG Close must ignore the open")
'''
    if declaration(source, 'zonesOverlap'):
        fixtures += '''
    check(zonesOverlap(110, 100, 110, 100), "equal intervals overlap")
    check(zonesOverlap(120, 90, 110, 100), "containing intervals overlap")
    check(not zonesOverlap(110, 100, 120, 110), "touching edges are not overlap")
    check(not zonesOverlap(210, 200, 110, 100), "disjoint intervals are not overlap")
    check(not mitigationHit(true, 100, "Close", 105), "Close ignores the lower wick and open")
    check(mitigationHit(true, 100, "Wick", 105), "Wick uses the low")
    check(mitigationHit(true, 100, "Avg", 105), "Avg uses the midpoint")
    check(not mitigationHit(false, 105, "Close", 100), "equal close does not break an upper boundary")
    check(mitigationHit(false, 105, "Wick", 100), "bearish Wick uses the high")
    shorts = array.new<ob>()
    shorts.push(testOB(70, 80, 100, false))
    shorts.push(testOB(90, 100, 200, false))
    shorts.mitigated()
    check(shorts.size() == 0, "consecutive invalid bearish OBs must all be removed")
    inverse = array.new<ob>()
    converted = testOB(100, 110, 100)
    converted.isbb := true
    inverse.push(converted)
    inverse.mitigated()
    check(inverse.size() == 1, "bullish breaker survives a close below its top")
    check(historyOffset(bar_index - 10000) <= HISTORY_LIMIT, "history must be bounded")
    check(historyOffset(bar_index + 1) == 0, "future anchor must not create negative offset")
'''
    fixtures += '''
    label.new(bar_index, 105, "REGRESSION PASS", color = color.green, textcolor = color.white)
plot(na)
'''
    attribution = '\n'.join(source.splitlines()[:2]) + '\n'
    return attribution + prefix + support + helpers + fixtures


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'TOOL.pine'
    policy = sys.argv[2] if len(sys.argv) > 2 else 'Recent'
    if policy not in ('Recent', 'Old'):
        raise ValueError('policy must be Recent or Old')
    out = root / 'tests' / f'regression-{policy.lower()}.pine'
    out.write_text(build(source.read_text(encoding='utf-8'), policy), encoding='utf-8')
    print(out)
