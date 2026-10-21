// Assembles the hand-written synthetic parts (data/parts/*.json) into the CSVs the app loads.
// The gold codes were assigned by hand at authoring time, never by Kappa's coding run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCsv } from "../lib/csv.js";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const QUESTION = "What did you think of last night's 6pm newscast?";

const items = fs.readdirSync(path.join(dataDir, "parts"))
  .filter((f) => f.endsWith(".json")).sort()
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dataDir, "parts", f), "utf8")));

fs.writeFileSync(path.join(dataDir, "verbatims.csv"),
  toCsv(["id", "question", "text"], items.map((v) => [v.id, QUESTION, v.text])));
fs.writeFileSync(path.join(dataDir, "golden.csv"),
  toCsv(["verbatim_id", "code"], items.flatMap((v) => v.gold.map((c) => [v.id, c]))));
fs.writeFileSync(path.join(dataDir, "golden_sidecar.csv"),
  toCsv(["verbatim_id", "kind", "type", "gold_codes", "note"], [
    ...items.filter((v) => v.hard).map((v) => [v.id, "hard_case", v.hard.type, v.gold.join(";"), v.hard.note]),
    ...items.filter((v) => v.machine).map((v) => [v.id, "machine_written", "", v.gold.join(";"), "Written to read as machine-generated; should be flagged non-human."]),
  ]));
console.log(`${items.length} verbatims, ${items.reduce((n, v) => n + v.gold.length, 0)} gold codes, ` +
  `${items.filter((v) => v.hard).length} hard cases, ${items.filter((v) => v.machine).length} machine-written`);
