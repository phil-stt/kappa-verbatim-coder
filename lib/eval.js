// Agreement between Kappa's codes and a human-coded golden set.
// Each verbatim x code cell is a yes/no judgment made by both coders; metrics are computed over those cells.

function kappa(tp, fp, fn, tn) {
  const n = tp + fp + fn + tn;
  if (!n) return null;
  const po = (tp + tn) / n;
  const pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}

const ratio = (a, b) => (b ? a / b : null);

// predicted: Map(id -> [{ code, span }]); golden: [{ verbatim_id, code }]; notes: Map(id -> { type, note })
export function evaluate({ verbatims, frame, predicted, golden, notes = new Map() }) {
  const human = new Map();
  for (const g of golden) {
    if (!human.has(g.verbatim_id)) human.set(g.verbatim_id, new Set());
    if (g.code) human.get(g.verbatim_id).add(g.code);
  }
  const studyIds = new Set(verbatims.map((v) => v.id));
  const ids = [...human.keys()].filter((id) => studyIds.has(id));
  const missing = [...human.keys()].filter((id) => !studyIds.has(id));
  const codes = [...new Set([...frame.map((c) => c.code), ...golden.map((g) => g.code).filter(Boolean)])];
  const label = new Map(frame.map((c) => [c.code, c.label]));
  const textById = new Map(verbatims.map((v) => [v.id, v.text]));

  const per = new Map(codes.map((c) => [c, { tp: 0, fp: 0, fn: 0, tn: 0 }]));
  const pairs = new Map();
  const disagreements = [];
  let exact = 0;

  for (const id of ids) {
    const h = human.get(id);
    const mList = predicted.get(id) || [];
    const m = new Set(mList.map((c) => c.code));
    for (const c of codes) {
      const s = per.get(c);
      if (h.has(c) && m.has(c)) s.tp++;
      else if (m.has(c)) s.fp++;
      else if (h.has(c)) s.fn++;
      else s.tn++;
    }
    const modelOnly = [...m].filter((c) => !h.has(c));
    const humanOnly = [...h].filter((c) => !m.has(c));
    if (!modelOnly.length && !humanOnly.length) { exact++; continue; }
    for (const a of modelOnly) for (const b of humanOnly) {
      const k = `${a}→${b}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    disagreements.push({
      id,
      text: textById.get(id),
      human: [...h],
      model: mList.map((c) => ({ code: c.code, span: c.span, confidence: c.confidence })),
      modelOnly,
      humanOnly,
      note: notes.get(id) || null,
    });
  }

  let TP = 0, FP = 0, FN = 0, TN = 0;
  const perCode = codes.map((c) => {
    const { tp, fp, fn, tn } = per.get(c);
    TP += tp; FP += fp; FN += fn; TN += tn;
    return {
      code: c,
      label: label.get(c) || c,
      human: tp + fn,
      model: tp + fp,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
      agreement: ratio(tp + tn, tp + fp + fn + tn),
      kappa: kappa(tp, fp, fn, tn),
    };
  });
  const precision = ratio(TP, TP + FP);
  const recall = ratio(TP, TP + FN);
  const kappas = perCode.filter((p) => p.human > 0 && p.kappa != null).map((p) => p.kappa);

  const goldenCodes = new Set(golden.map((g) => g.code));
  return {
    n: ids.length,
    missingFromStudy: missing,
    codesNotInGolden: frame.map((c) => c.code).filter((c) => !goldenCodes.has(c)),
    overall: {
      exactMatch: ratio(exact, ids.length),
      precision,
      recall,
      f1: precision != null && recall != null && precision + recall ? (2 * precision * recall) / (precision + recall) : null,
      pooledKappa: kappa(TP, FP, FN, TN),
      meanKappa: kappas.length ? kappas.reduce((a, b) => a + b, 0) / kappas.length : null,
    },
    perCode,
    confusedPairs: [...pairs.entries()].map(([pair, count]) => {
      const [model, human] = pair.split("→");
      return { model, human, count };
    }).sort((a, b) => b.count - a.count).slice(0, 10),
    disagreements,
  };
}
