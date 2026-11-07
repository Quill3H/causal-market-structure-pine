"""Build deterministic Pine tests from production signal helpers."""
from pathlib import Path
from build_regression import schema, declaration

root = Path(__file__).resolve().parents[1]
s = (root / 'TOOL.pine').read_text(encoding='utf-8')
out = '\n'.join(s.splitlines()[:2]) + '''
//@version=6
indicator("SMC arrow regression", overlay = true)
// Deterministic candle used by the real signalCandidate helper.
float high = 104
float low = 101
float close = 103
string signalMode = "Strict"
int signalMinEvidence = 2
bool signalUseMapping = true
bool signalUseFVG = true
bool signalUseSweep = true
bool signalUseVolume = true
bool signalUseSourceVolume = true
float signalVolumeMin = 1.2
float signalSourceMin = 1.0
'''
out += schema(s, 'ob') + schema(s, 'FVG')
for name in ('zonesOverlap', 'relativeVolume', 'recentEvent', 'zoneRejection', 'gapConfirmation', 'signalEvidence', 'evidenceDecision', 'signalAgreement', 'resolveSignals', 'signalCandidate'):
    out += declaration(s, name)
out += '''
checkSignal(bool ok, string message) =>
    if not ok
        runtime.error(message)
    true

if barstate.islastconfirmedhistory
    checkSignal(evidenceDecision("Balanced", 2, 2, 5, true), "balanced accepts two checks")
    checkSignal(not evidenceDecision("Balanced", 2, 1, 5, true), "balanced blocks below threshold")
    checkSignal(not evidenceDecision("Strict", 2, 4, 5, true), "strict requires every check")
    checkSignal(not evidenceDecision("Balanced", 2, 5, 5, false), "missing volume cannot be outvoted")
    checkSignal(evidenceDecision("Balanced", 2, 1, 1, true), "threshold capped to enabled checks")
    checkSignal(evidenceDecision("Balanced", 2, 0, 0, true), "all disabled uses mandatory structure and OB only")
    [partialScore, enabledChecks, dataReady] = signalEvidence(1, 1, false, false, 1.2, 0.8)
    checkSignal(partialScore == 2 and enabledChecks == 5 and dataReady, "all enabled evidence contributes to score")
    checkSignal(evidenceDecision("Balanced", 2, partialScore, enabledChecks, dataReady), "balanced can accept partial agreement")
    buyZone = ob.new(bull = true, top = 102, btm = 100, avg = 101, loc = 1000)
    sellZone = ob.new(bull = false, top = 110, btm = 108, avg = 109, loc = 1000)
    checkSignal(zoneRejection(buyZone, 1, 2000, 104, 101, 103), "valid bullish rejection")
    checkSignal(zoneRejection(sellZone, -1, 2000, 109, 106, 107), "valid bearish rejection")
    checkSignal(not zoneRejection(buyZone, 1, 2000, 105, 103, 104), "price must touch the OB")
    checkSignal(not zoneRejection(buyZone, 1, 2000, 103, 101, 102), "close must strictly leave the zone")
    checkSignal(not zoneRejection(buyZone, 1, 1000, 104, 101, 103), "no creation-candle arrow")
    buyZone.isbb := true
    checkSignal(not zoneRejection(buyZone, 1, 2000, 104, 101, 103), "breaker is not an active normal OB")
    buyZone.isbb := false
    buyZone.signaled := true
    checkSignal(not zoneRejection(buyZone, 1, 2000, 104, 101, 103), "one arrow per OB")
    buyZone.signaled := false
    checkSignal(relativeVolume(240, 200) == 1.2, "RVOL ratio")
    checkSignal(na(relativeVolume(240, 0)), "zero denominator is unavailable")
    checkSignal(na(relativeVolume(na, 200)), "missing volume is unavailable")
    checkSignal(recentEvent(95, 100, 10), "recent sweep is usable")
    checkSignal(not recentEvent(89, 100, 10), "stale sweep is not usable")
    checkSignal(not recentEvent(101, 100, 10), "future sweep cannot qualify")
    checkSignal(signalAgreement(1, 1, 1, true, true, 1.2, 1.0), "all bullish evidence agrees")
    checkSignal(signalAgreement(-1, -1, -1, true, true, 1.2, 1.0), "all bearish evidence agrees")
    checkSignal(not signalAgreement(1, -1, 1, true, true, 1.2, 1.0), "structure conflict blocks")
    checkSignal(not signalAgreement(1, 1, -1, true, true, 1.2, 1.0), "mapping conflict blocks")
    checkSignal(not signalAgreement(1, 1, 1, false, true, 1.2, 1.0), "missing FVG blocks")
    checkSignal(not signalAgreement(1, 1, 1, true, false, 1.2, 1.0), "missing sweep blocks")
    checkSignal(not signalAgreement(1, 1, 1, true, true, 1.19, 1.0), "weak confirmation volume blocks")
    checkSignal(not signalAgreement(1, 1, 1, true, true, na, 1.0), "unknown confirmation volume blocks")
    checkSignal(not signalAgreement(1, 1, 1, true, true, 1.2, 0.99), "weak source volume blocks")
    [buy, sell] = resolveSignals(true, 0, -1)
    checkSignal(buy and not sell, "only bullish setup emits up arrow")
    [downBuy, downSell] = resolveSignals(true, -1, 0)
    checkSignal(not downBuy and downSell, "only bearish setup emits down arrow")
    [liveBuy, liveSell] = resolveSignals(false, 0, -1)
    checkSignal(not liveBuy and not liveSell, "no arrow on an unfinished candle")
    [bothBuy, bothSell] = resolveSignals(true, 0, 0)
    checkSignal(not bothBuy and not bothSell, "conflicting setups emit neither")
    gaps = array.new<FVG>()
    gaps.push(FVG.new(top = 102, btm = 101, loc = 1000))
    checkSignal(gapConfirmation(gaps, buyZone, 1, 2000, 104, 101.5, 103), "overlapping confirmed gap qualifies")
    checkSignal(not gapConfirmation(gaps, buyZone, 1, 2000, 104, 102.5, 103), "must touch common OB/FVG price area")
    checkSignal(not gapConfirmation(gaps, buyZone, 1, 1000, 104, 101.5, 103), "same-candle FVG is excluded")
    testGap = gaps.get(0)
    testGap.isbb := true
    checkSignal(not gapConfirmation(gaps, buyZone, 1, 2000, 104, 101.5, 103), "invalidated gap is excluded")
    // Exercise the production selector and consume the same reference it returns.
    buyZone.loc := time - 1
    buyZone.sourceRvol := 1.0
    testGap.loc := time - 1
    testGap.isbb := false
    candidates = array.new<ob>()
    candidates.push(buyZone)
    selected = signalCandidate(candidates, gaps, 1, 1, 1, true, 1.2)
    checkSignal(selected == 0, "complete bullish pipeline must select the zone")
    [selectedBuy, selectedSell] = resolveSignals(true, selected, -1)
    checkSignal(selectedBuy and not selectedSell, "bullish selector feeds the plotted direction")
    selectedZone = candidates.get(selected)
    selectedZone.signaled := true
    checkSignal(signalCandidate(candidates, gaps, 1, 1, 1, true, 1.2) == -1, "consumed OB must not emit again")
    bearCandidates = array.new<ob>()
    bearCandidates.push(ob.new(bull = false, top = 106, btm = 104, avg = 105, loc = time - 1, sourceRvol = 1.0))
    bearGaps = array.new<FVG>()
    bearGaps.push(FVG.new(top = 105, btm = 104, loc = time - 1))
    selectedBear = signalCandidate(bearCandidates, bearGaps, -1, -1, -1, true, 1.2)
    checkSignal(selectedBear == 0, "complete bearish pipeline must select the zone")
    [selectedBearBuy, selectedBearSell] = resolveSignals(true, -1, selectedBear)
    checkSignal(not selectedBearBuy and selectedBearSell, "bearish selector feeds the plotted direction")
    signalMode := "Balanced"
    buyZone.signaled := false
    buyZone.sourceRvol := 0.8
    emptyGaps = array.new<FVG>()
    checkSignal(signalCandidate(candidates, emptyGaps, 1, 1, 1, false, 1.2) == 0, "balanced selector accepts mapping and confirmation volume")
    checkSignal(signalCandidate(candidates, emptyGaps, 1, 1, -1, false, 1.2) == -1, "balanced selector blocks only one check")
    checkSignal(signalCandidate(candidates, emptyGaps, 1, -1, 1, false, 1.2) == -1, "balanced still requires matching structure")
    checkSignal(signalCandidate(candidates, emptyGaps, 1, 1, 1, false, na) == -1, "balanced blocks missing enabled volume")
    label.new(bar_index, high, "ARROWS PASS", color = color.green)
plot(na)
'''
p = root / 'tests' / 'regression-signals.pine'
p.write_bytes(out.encode('utf-8'))
print(p)
