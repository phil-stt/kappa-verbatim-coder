// Headless eval: codes the bundled synthetic study with one adapter and scores it against the
// golden set, without touching the app's study. Usage: node scripts/eval-cli.js [anthropic|lexical]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvObjects } from "../lib/csv.js";
import { Study } from "../lib/study.js";
import { createAdapter } from "../lib/adapters/index.js";
import { evaluate } from "../lib/eval.js";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const read = (f) => parseCsvObjects(fs.readFileSync(path.join(dataDir, f), "utf8"));

const adapter = createAdapter(process.argv[2] || "lexical");
const study = new Study(fs.mkdtempSync(path.join(os.tmpdir(), "kappa-eval-")));
study.setup({ frame: read("code_frame.csv"), verbatims: read("verbatims.csv"), threshold: 0.8 });
const t0 = Date.now();
const run = await study.run(adapter);
const r = evaluate({
  verbatims: study.state.verbatims,
  frame: study.state.frame,
  predicted: new Map(study.rows().map((row) => [row.id, row.model])),
  golden: read("golden.csv"),
});
const f = (x) => (x == null ? "–" : x.toFixed(3));
console.log(`${run.adapter}: ${r.n} verbatims in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${run.errors.length} errors`);
console.log(`pooled kappa ${f(r.overall.pooledKappa)} | mean per-code kappa ${f(r.overall.meanKappa)} | exact match ${f(r.overall.exactMatch)} | P ${f(r.overall.precision)} R ${f(r.overall.recall)} F1 ${f(r.overall.f1)}`);
for (const p of r.perCode) console.log(`  ${p.code.padEnd(9)} human ${String(p.human).padStart(3)} model ${String(p.model).padStart(3)}  P ${f(p.precision)} R ${f(p.recall)} kappa ${f(p.kappa)}`);
const machine = new Set(read("golden_sidecar.csv").filter((s) => s.kind === "machine_written").map((s) => s.verbatim_id));
const flagged = study.rows().filter((row) => row.non_human).map((row) => row.id);
console.log(`non-human flag: caught ${flagged.filter((id) => machine.has(id)).length} of ${machine.size}; false positives: ${flagged.filter((id) => !machine.has(id)).join(", ") || "none"}`);
console.log("top confusions:", r.confusedPairs.slice(0, 5).map((c) => `${c.model}->${c.human} x${c.count}`).join(", ") || "none");
