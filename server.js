// Kappa: local web app for the Verbatim Coder. `npm start`, then open the printed URL.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTable, parseCsvObjects } from "./lib/csv.js";
import { Study } from "./lib/study.js";
import { createAdapter, adapterNames } from "./lib/adapters/index.js";
import { evaluate } from "./lib/eval.js";
import { longCsv, wideCsv, summaryCsv, frequency } from "./lib/export.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4317;
const study = new Study(path.join(root, "study"));
let adapterName = process.env.KAPPA_ADAPTER || "anthropic";
let adapter = createAdapter(adapterName);

const sample = (f) => fs.readFileSync(path.join(root, "data", f), "utf8");

function parseFrame(text) {
  return readTable(text, ["code", "label", "description"], "Code frame").map((r) => ({
    code: r.code.toUpperCase(), label: r.label, description: r.description,
  }));
}

function parseVerbatims(text) {
  return readTable(text, ["id", "question", "text"], "Verbatims").filter((r) => r.id).map((r) => ({
    id: r.id, question: r.question, text: r.text,
  }));
}

function parseGolden(text) {
  return readTable(text, ["verbatim_id", "code"], "Golden set").map((r) => ({ verbatim_id: r.verbatim_id, code: r.code.toUpperCase() }));
}

// Score the non-human flag against the sidecar's list of verbatims written to read as machine-generated.
function nonHumanEval() {
  const actual = new Set(parseCsvObjects(sample("golden_sidecar.csv")).filter((r) => r.kind === "machine_written").map((r) => r.verbatim_id));
  const flagged = study.rows().filter((r) => r.non_human).map((r) => r.id);
  const tp = flagged.filter((id) => actual.has(id)).length;
  return {
    actual: actual.size,
    flagged: flagged.length,
    caught: tp,
    falsePositives: flagged.filter((id) => !actual.has(id)),
    missed: [...actual].filter((id) => !flagged.includes(id)),
  };
}

function sidecarNotes() {
  const notes = new Map();
  for (const r of parseCsvObjects(sample("golden_sidecar.csv"))) {
    const prev = notes.get(r.verbatim_id);
    const note = r.kind === "hard_case" ? `Hard case (${r.type}): ${r.note}` : r.note;
    notes.set(r.verbatim_id, prev ? `${prev} ${note}` : note);
  }
  return notes;
}

function summary() {
  const s = study.state;
  return {
    adapter: adapter.describe(),
    adapterName,
    adapters: adapterNames,
    question: s.question,
    threshold: s.threshold,
    frame: s.frame,
    verbatimCount: s.verbatims.length,
    decisions: Object.keys(s.decisions).length,
    run: s.run && {
      adapter: s.run.adapter, startedAt: s.run.startedAt, finishedAt: s.run.finishedAt,
      coded: Object.keys(s.run.results).length, errors: s.run.errors.length, frameCodes: s.run.frameCodes,
    },
    progress: study.progress,
    proposalsPending: s.proposals.filter((p) => p.status === "pending").length,
    golden: s.golden ? { source: s.golden.source, rows: s.golden.rows.length } : null,
  };
}

const routes = {
  "GET /api/state": () => summary(),

  "POST /api/setup": ({ body }) => {
    const frame = parseFrame(body.useSample ? sample("code_frame.csv") : body.frameCsv || "");
    const verbatims = parseVerbatims(body.useSample ? sample("verbatims.csv") : body.verbatimCsv || "");
    const threshold = Number(body.threshold ?? 0.8);
    if (!(threshold >= 0 && threshold <= 1)) throw new Error("Threshold must be between 0 and 1");
    study.setup({ frame, verbatims, threshold });
    return summary();
  },

  "POST /api/threshold": ({ body }) => {
    const t = Number(body.threshold);
    if (!(t >= 0 && t <= 1)) throw new Error("Threshold must be between 0 and 1");
    study.setThreshold(t);
    return summary();
  },

  "POST /api/adapter": ({ body }) => {
    adapter = createAdapter(body.name);
    adapterName = body.name;
    return summary();
  },

  "POST /api/run": () => {
    study.run(adapter).catch((e) => console.error("Run failed:", e.message));
    return summary();
  },

  "GET /api/results": () => ({ rows: study.rows(), errors: study.state.run?.errors || [], threshold: study.state.threshold }),

  "GET /api/review": () => study.reviewQueue(),

  "POST /api/decision": ({ body }) => {
    if (body.undo) study.undecide(body.id);
    else study.decide(body.id, body.codes || []);
    return { ok: true };
  },

  "GET /api/proposals": () => {
    const byId = new Map(study.state.verbatims.map((v) => [v.id, v.text]));
    return {
      proposals: study.state.proposals.map((p) => ({ ...p, examples: p.example_ids.map((id) => ({ id, text: byId.get(id) || "" })) })),
    };
  },

  "POST /api/proposals/generate": async () => ({ added: await study.propose(adapter) }),

  "POST /api/proposals/resolve": ({ body }) => {
    study.resolveProposal(body.code, !!body.approve);
    return { ok: true };
  },

  "GET /api/frequency": () => ({ frequency: frequency(study), n: study.state.verbatims.length }),

  "POST /api/eval": ({ body }) => {
    if (body.useSample) study.state.golden = { source: "data/golden.csv (synthetic)", rows: parseGolden(sample("golden.csv")) };
    else if (body.goldenCsv) study.state.golden = { source: body.name || "uploaded file", rows: parseGolden(body.goldenCsv) };
    if (!study.state.golden) throw new Error("Load a golden set first");
    study.save();
    if (!study.state.run) throw new Error("Run coding first");
    const includeHuman = body.mode === "final";
    const predicted = new Map(study.rows().map((r) => [r.id, includeHuman ? r.codes : r.model]));
    const synthetic = study.state.golden.source.includes("synthetic");
    const notes = synthetic ? sidecarNotes() : new Map();
    return {
      nonHuman: synthetic ? nonHumanEval() : null,
      mode: includeHuman ? "final codes (model + review decisions)" : "model output only",
      adapter: study.state.run.adapter,
      golden: study.state.golden.source,
      ...evaluate({ verbatims: study.state.verbatims, frame: study.state.frame, predicted, golden: study.state.golden.rows, notes }),
    };
  },
};

const downloads = {
  "/export/coded_long.csv": () => longCsv(study),
  "/export/coded_wide.csv": () => wideCsv(study),
  "/export/code_frequency.csv": () => summaryCsv(study),
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      const out = await route({ body: req.method === "POST" ? await readBody(req) : {}, url });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(out));
    }
    if (downloads[url.pathname]) {
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="kappa_${path.basename(url.pathname)}"`,
      });
      return res.end(downloads[url.pathname]());
    }
    const file = path.join(root, "public", url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (file.startsWith(path.join(root, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Kappa is running at http://localhost:${PORT}`);
  console.log(`Coder: ${adapter.describe()}`);
});
