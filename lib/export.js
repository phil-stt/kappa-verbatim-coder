// Export the study's final codes (human decisions override the model) as CSV.
// needs_review marks verbatims still waiting in the review queue, so analysts can filter them out.
import { toCsv } from "./csv.js";

function pendingIds(study) {
  return new Set(study.reviewQueue().items.filter((i) => !i.decided).map((i) => i.id));
}

export function longCsv(study) {
  const pending = pendingIds(study);
  const rows = [];
  for (const r of study.rows()) {
    for (const c of r.codes) {
      rows.push([r.id, c.code, c.confidence == null ? "" : c.confidence.toFixed(3), c.span, c.source, pending.has(r.id) ? 1 : 0]);
    }
  }
  return toCsv(["verbatim_id", "code", "confidence", "span", "source", "needs_review"], rows);
}

export function wideCsv(study) {
  const pending = pendingIds(study);
  const codes = study.state.frame.map((c) => c.code);
  const rows = study.rows().map((r) => {
    const have = new Set(r.codes.map((c) => c.code));
    return [r.id, r.text, r.decided ? "human" : "model", pending.has(r.id) ? 1 : 0, ...codes.map((c) => (have.has(c) ? 1 : 0))];
  });
  return toCsv(["verbatim_id", "text", "source", "needs_review", ...codes], rows);
}

export function frequency(study) {
  const rows = study.rows();
  const counts = new Map(study.state.frame.map((c) => [c.code, 0]));
  for (const r of rows) for (const c of r.codes) counts.set(c.code, (counts.get(c.code) || 0) + 1);
  return study.state.frame
    .map((c) => ({ code: c.code, label: c.label, count: counts.get(c.code), pct: rows.length ? counts.get(c.code) / rows.length : 0 }))
    .sort((a, b) => b.count - a.count);
}

export function summaryCsv(study) {
  return toCsv(["code", "label", "verbatims", "pct_of_verbatims"],
    frequency(study).map((f) => [f.code, f.label, f.count, (100 * f.pct).toFixed(1)]));
}
