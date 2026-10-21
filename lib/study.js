// One study: frame, verbatims, the latest model run, human decisions, and frame proposals.
// Persisted as JSON under study/ so decisions survive restarts and re-runs.
import fs from "node:fs";
import path from "node:path";
import { nearDuplicateGroups } from "./dupes.js";

const BATCH_SIZE = 20;
const CONCURRENCY = 4;

function emptyState() {
  return {
    question: "",
    threshold: 0.8,
    frame: [],          // [{ code, label, description, origin: "base" | "approved" }]
    verbatims: [],      // [{ id, question, text }]
    run: null,          // { adapter, startedAt, finishedAt, frameCodes, results: { [id]: { codes, non_human, non_human_reason } }, errors }
    decisions: {},      // { [id]: { codes: [{ code, span }], decidedAt } }  final human code set, overrides the model
    proposals: [],      // [{ code, label, description, example_ids, status: "pending" | "approved" | "rejected" }]
  };
}

// Find the span in the text; returns the exact substring as it appears, or "" if the model's quote isn't there.
export function locateSpan(text, span) {
  if (!span) return "";
  const i = text.toLowerCase().indexOf(span.trim().toLowerCase());
  return i < 0 ? "" : text.slice(i, i + span.trim().length);
}

export class Study {
  constructor(dir) {
    this.file = path.join(dir, "state.json");
    fs.mkdirSync(dir, { recursive: true });
    this.state = fs.existsSync(this.file) ? { ...emptyState(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) } : emptyState();
    this.progress = null;
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1));
  }

  // New frame or verbatims start a new study: earlier decisions and proposals no longer apply.
  setup({ frame, verbatims, threshold }) {
    const s = emptyState();
    s.frame = frame.map((c) => ({ ...c, origin: "base" }));
    s.verbatims = verbatims;
    s.question = verbatims[0]?.question || "";
    s.threshold = threshold;
    this.state = s;
    this.save();
  }

  setThreshold(t) {
    this.state.threshold = t;
    this.save();
  }

  rejectedProposalSummaries() {
    return this.state.proposals.filter((p) => p.status === "rejected").map((p) => `${p.code} (${p.label})`);
  }

  async run(adapter) {
    if (this.progress?.running) throw new Error("A coding run is already in progress");
    const { verbatims, frame, question } = this.state;
    if (!verbatims.length || !frame.length) throw new Error("Load a code frame and verbatims first");
    const batches = [];
    for (let i = 0; i < verbatims.length; i += BATCH_SIZE) batches.push(verbatims.slice(i, i + BATCH_SIZE));
    const run = {
      adapter: adapter.describe(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      frameCodes: frame.map((c) => c.code),
      results: {},
      errors: [],
    };
    this.progress = { running: true, done: 0, total: verbatims.length, startedAt: Date.now() };
    const valid = new Set(run.frameCodes);
    const byId = new Map(verbatims.map((v) => [v.id, v]));

    const work = async (batch) => {
      try {
        const out = await adapter.codeBatch({ frame, question, items: batch });
        for (const r of out) {
          const v = byId.get(r.id);
          if (!v) continue;
          const seen = new Set();
          const codes = [];
          for (const c of r.codes) {
            if (!valid.has(c.code) || seen.has(c.code)) continue;
            seen.add(c.code);
            const span = locateSpan(v.text, c.span);
            codes.push({ code: c.code, confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0)), span, spanVerified: !!span });
          }
          run.results[v.id] = { codes, non_human: !!r.non_human, non_human_reason: r.non_human_reason || "" };
        }
        for (const v of batch) if (!run.results[v.id]) run.errors.push({ id: v.id, error: "No result returned for this verbatim" });
      } catch (e) {
        for (const v of batch) run.errors.push({ id: v.id, error: e.message });
      }
      this.progress.done += batch.length;
    };

    const queue = [...batches];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) await work(queue.shift());
    }));
    run.finishedAt = new Date().toISOString();
    this.state.run = run;
    this.progress = { ...this.progress, running: false, finishedAt: Date.now() };
    this.save();
    return run;
  }

  // Final codes per verbatim: a human decision overrides the model output.
  finalCodes(id) {
    const d = this.state.decisions[id];
    if (d) return d.codes.map((c) => ({ code: c.code, span: c.span || "", confidence: null, source: "human" }));
    const r = this.state.run?.results[id];
    if (!r) return [];
    return r.codes.map((c) => ({ code: c.code, span: c.span, confidence: c.confidence, source: "model" }));
  }

  rows() {
    return this.state.verbatims.map((v) => {
      const r = this.state.run?.results[v.id];
      return {
        id: v.id,
        text: v.text,
        model: r?.codes || [],
        non_human: r?.non_human || false,
        non_human_reason: r?.non_human_reason || "",
        decided: !!this.state.decisions[v.id],
        codes: this.finalCodes(v.id),
      };
    });
  }

  reviewQueue() {
    const run = this.state.run;
    if (!run) return { items: [], groups: [] };
    const t = this.state.threshold;
    const items = [];
    const rows = this.rows();
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const row of rows) {
      const reasons = [];
      if (run.errors.some((e) => e.id === row.id)) reasons.push("error");
      else if (!row.model.length) reasons.push("uncoded");
      const low = row.model.filter((c) => c.confidence < t);
      if (low.length) reasons.push(`below threshold (${low.map((c) => `${c.code} ${c.confidence.toFixed(2)}`).join(", ")})`);
      if (row.model.some((c) => !c.spanVerified)) reasons.push("span not found in text");
      if (row.non_human) reasons.push("flagged non-human");
      if (reasons.length) items.push({ ...row, reasons });
    }
    const groups = nearDuplicateGroups(this.state.verbatims).map((ids) => ids.map((id) => rowById.get(id)));
    return { items, groups };
  }

  decide(id, codes) {
    if (!this.state.verbatims.some((v) => v.id === id)) throw new Error(`Unknown verbatim ${id}`);
    const valid = new Set(this.state.frame.map((c) => c.code));
    const bad = codes.filter((c) => !valid.has(c.code));
    if (bad.length) throw new Error(`Not in the frame: ${bad.map((c) => c.code).join(", ")}`);
    const text = this.state.verbatims.find((v) => v.id === id).text;
    this.state.decisions[id] = {
      codes: codes.map((c) => ({ code: c.code, span: locateSpan(text, c.span || "") })),
      decidedAt: new Date().toISOString(),
    };
    this.save();
  }

  undecide(id) {
    delete this.state.decisions[id];
    this.save();
  }

  async propose(adapter) {
    const run = this.state.run;
    if (!run) throw new Error("Run coding first; proposals come from what the run could not place");
    const otherCodes = new Set(this.state.frame.filter((c) => /^other$/i.test(c.label)).map((c) => c.code));
    const pool = this.rows().filter((r) =>
      !r.codes.length || r.codes.some((c) => otherCodes.has(c.code)) || r.model.every((c) => c.confidence < this.state.threshold));
    if (pool.length < 3) return [];
    const existing = new Set([...this.state.frame.map((c) => c.code), ...this.state.proposals.map((p) => p.code)]);
    const poolIds = new Set(pool.map((r) => r.id));
    const proposals = await adapter.propose({
      frame: this.state.frame,
      question: this.state.question,
      items: pool.map((r) => ({ id: r.id, text: r.text })),
      rejected: this.rejectedProposalSummaries(),
    });
    const fresh = [];
    for (const p of proposals) {
      const code = p.code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 20);
      if (!code || existing.has(code)) continue;
      existing.add(code);
      fresh.push({
        code,
        label: p.label,
        description: p.description,
        example_ids: p.example_ids.filter((id) => poolIds.has(id)).slice(0, 3),
        status: "pending",
        proposedAt: new Date().toISOString(),
      });
    }
    this.state.proposals.push(...fresh);
    this.save();
    return fresh;
  }

  resolveProposal(code, approve) {
    const p = this.state.proposals.find((x) => x.code === code && x.status === "pending");
    if (!p) throw new Error(`No pending proposal ${code}`);
    p.status = approve ? "approved" : "rejected";
    if (approve) this.state.frame.push({ code: p.code, label: p.label, description: p.description, origin: "approved" });
    this.save();
  }
}
