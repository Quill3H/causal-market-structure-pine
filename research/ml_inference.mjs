import assert from 'node:assert/strict';

function expit(x) {
  if (x >= 0) {
    return 1 / (1 + Math.exp(-x));
  }
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

function buildFeatureVector(featureMap, featureNames) {
  assert.ok(Array.isArray(featureNames) && featureNames.length > 0, 'Expected non-empty featureNames');
  const vec = new Float64Array(featureNames.length);
  if (Array.isArray(featureMap) || ArrayBuffer.isView(featureMap)) {
    assert.equal(featureMap.length, featureNames.length, 'Feature vector length mismatch');
    for (let j = 0; j < featureNames.length; j++) {
      const v = featureMap[j];
      vec[j] = v === null || v === undefined ? NaN : Number(v);
    }
    return vec;
  }
  assert.ok(featureMap && typeof featureMap === 'object', 'Expected featureMap object or array');
  for (let j = 0; j < featureNames.length; j++) {
    const v = featureMap[featureNames[j]];
    vec[j] = v === null || v === undefined ? NaN : Number(v);
  }
  return vec;
}

function applyPreprocess(vec, imputer, scaler) {
  const d = vec.length;
  const out = new Float64Array(d);
  const medians = imputer?.medians ?? null;
  const means = scaler?.mean ?? null;
  const scales = scaler?.scale ?? null;

  for (let j = 0; j < d; j++) {
    let v = vec[j];
    if (!Number.isFinite(v)) {
      v = medians ? medians[j] : 0;
    }
    if (means && scales) {
      const s = scales[j] === 0 ? 1 : scales[j];
      v = (v - means[j]) / s;
    }
    out[j] = v;
  }
  return out;
}

function predictSingleTreeValue(tree, xScaled) {
  // scikit-learn DecisionTreeRegressor casts input features to float32 before threshold comparisons.
  let nodeIdx = 0;
  const { childrenLeft, childrenRight, feature, threshold, value } = tree;
  while (true) {
    const f = feature[nodeIdx];
    if (f < 0) {
      return value[nodeIdx];
    }
    const xf32 = Math.fround(xScaled[f]);
    nodeIdx = xf32 <= threshold[nodeIdx] ? childrenLeft[nodeIdx] : childrenRight[nodeIdx];
  }
}

export function predictProbaV5(featureMap, modelSpec) {
  assert.ok(modelSpec && typeof modelSpec === 'object', 'Expected modelSpec object');

  if (modelSpec.modelType === 'ensemble' || Array.isArray(modelSpec.models)) {
    const res = evaluateEnsemble(featureMap, modelSpec);
    return res.probWin;
  }

  const vec = buildFeatureVector(featureMap, modelSpec.featureNames);
  const xScaled = applyPreprocess(vec, modelSpec.imputer, modelSpec.scaler);

  if (modelSpec.modelType === 'logistic_regression') {
    const { coef, intercept } = modelSpec.classifier;
    assert.equal(coef.length, xScaled.length, 'LogisticRegression coef length mismatch');
    let logit = intercept;
    for (let j = 0; j < xScaled.length; j++) {
      logit += coef[j] * xScaled[j];
    }
    return expit(logit);
  }

  if (modelSpec.modelType === 'gradient_boosting') {
    const { initScore, learningRate, trees } = modelSpec.classifier;
    let raw = initScore;
    for (let t = 0; t < trees.length; t++) {
      raw += learningRate * predictSingleTreeValue(trees[t], xScaled);
    }
    return expit(raw);
  }

  throw new Error(`Unsupported modelType: ${modelSpec.modelType}`);
}

export function computeConfidenceSizeMult(probWin, threshold = 0.5, sizeCurve = null) {
  if (!Number.isFinite(probWin) || probWin < threshold) return 0;
  if (!sizeCurve || sizeCurve.mode === 'flat') return 1.0;

  const minMult = Number.isFinite(sizeCurve.minMult) ? sizeCurve.minMult : 1.0;
  const maxMult = Number.isFinite(sizeCurve.maxMult) ? sizeCurve.maxMult : 1.0;
  if (sizeCurve.mode === 'linear') {
    const pMax = Number.isFinite(sizeCurve.pMax) && sizeCurve.pMax > threshold ? sizeCurve.pMax : Math.min(0.95, threshold + 0.25);
    const u = Math.max(0, Math.min(1, (probWin - threshold) / (pMax - threshold)));
    return minMult + u * (maxMult - minMult);
  }
  if (sizeCurve.mode === 'step') {
    const highProb = Number.isFinite(sizeCurve.highProb) ? sizeCurve.highProb : threshold + 0.1;
    return probWin >= highProb ? maxMult : minMult;
  }
  return 1.0;
}

export function scoreCandidateV5(featureMap, modelSpec) {
  assert.ok(modelSpec && typeof modelSpec === 'object', 'Expected modelSpec object');
  if (modelSpec.modelType === 'ensemble' || Array.isArray(modelSpec.models)) {
    return evaluateEnsemble(featureMap, modelSpec);
  }

  const probWin = predictProbaV5(featureMap, modelSpec);
  const threshold = Number.isFinite(modelSpec.threshold) ? modelSpec.threshold : 0.5;
  const pass = probWin >= threshold;
  const sizeMult = computeConfidenceSizeMult(probWin, threshold, modelSpec.sizeCurve ?? null);
  const rawScore = probWin > 0 && probWin < 1 ? Math.log(probWin / (1 - probWin)) : (probWin >= 1 ? 50 : -50);

  return {
    probWin,
    rawScore,
    pass,
    sizeMult,
    threshold,
    modelType: modelSpec.modelType,
  };
}

export function evaluateEnsemble(featureMap, modelsOrSpec, options = {}) {
  let items;
  let threshold = options.threshold;
  let sizeCurve = options.sizeCurve;

  if (Array.isArray(modelsOrSpec)) {
    const weights = options.weights ?? null;
    items = modelsOrSpec.map((m, idx) => ({
      weight: weights ? weights[idx] : (m.weight ?? 1),
      model: m.model ?? m,
    }));
  } else if (modelsOrSpec && Array.isArray(modelsOrSpec.models)) {
    items = modelsOrSpec.models.map(entry => ({
      weight: entry.weight ?? 1,
      model: entry.model ?? entry,
    }));
    if (threshold === undefined) threshold = modelsOrSpec.threshold;
    if (sizeCurve === undefined) sizeCurve = modelsOrSpec.sizeCurve;
  } else {
    throw new Error('evaluateEnsemble expects an array of models or an ensemble modelSpec');
  }

  assert.ok(items.length > 0, 'Expected at least one model in ensemble');
  let weightSum = 0;
  let probSum = 0;
  const perModel = [];

  for (const item of items) {
    const w = Number.isFinite(item.weight) ? item.weight : 1;
    assert.ok(w >= 0, 'Ensemble weight must be non-negative');
    const p = predictProbaV5(featureMap, item.model);
    perModel.push({
      modelType: item.model.modelType,
      weight: w,
      probWin: p,
    });
    weightSum += w;
    probSum += w * p;
  }

  assert.ok(weightSum > 0, 'Total ensemble weight must be > 0');
  const probWin = probSum / weightSum;
  const effThreshold = Number.isFinite(threshold) ? threshold : 0.5;
  const pass = probWin >= effThreshold;
  const sizeMult = computeConfidenceSizeMult(probWin, effThreshold, sizeCurve ?? null);

  return {
    probWin,
    pass,
    sizeMult,
    threshold: effThreshold,
    modelType: 'ensemble',
    perModel,
  };
}
