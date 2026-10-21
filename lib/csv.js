// Minimal RFC 4180 CSV parsing and writing. No dependencies.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Parse into objects keyed by the (lowercased, trimmed) header row.
export function parseCsvObjects(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

// Read a CSV and check it has the named columns; throws a readable error if not.
export function readTable(text, required, what) {
  const objs = parseCsvObjects(text);
  if (!objs.length) throw new Error(`${what}: no rows found`);
  const missing = required.filter((k) => !(k in objs[0]));
  if (missing.length) throw new Error(`${what}: missing column(s) ${missing.join(", ")}; expected ${required.join(", ")}`);
  return objs;
}

function cell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
