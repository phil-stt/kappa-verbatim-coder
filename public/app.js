// Kappa UI: six screens over the local API. No framework; each screen renders into #view.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (x, d = 0) => (x == null ? "–" : `${(100 * x).toFixed(d)}%`);
const num = (x, d = 2) => (x == null ? "–" : x.toFixed(d));

const PALETTE = ["#3b7dd8", "#d8833b", "#2f9e6e", "#c94f6d", "#8a63d2", "#c9a227", "#1aa3b8", "#9c5b3c", "#5e8c31", "#d65fb0", "#6b7a8f", "#7f8c2a", "#b8486b", "#2a7f8c", "#a46cd6", "#cc6d2e"];
let state = null;
let tab = location.hash.slice(1) || "setup";
let pollTimer = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (error ? " error" : "");
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), error ? 6000 : 2500);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e.message, true); }
};

function colorOf(code) {
  const i = state?.frame.findIndex((c) => c.code === code) ?? -1;
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

function chip(c, { threshold, removable } = {}) {
  const conf = c.confidence == null ? "" : `<span class="conf ${threshold != null && c.confidence < threshold ? "low" : ""}">${c.confidence.toFixed(2)}</span>`;
  const x = removable ? `<button title="Remove" data-remove="${esc(c.code)}">×</button>` : "";
  return `<span class="chip ${c.source === "human" ? "human" : ""}" style="--c:${colorOf(c.code)}" title="${esc(c.span || "no span")}">${esc(c.code)} ${conf}${x}</span>`;
}

// Highlight each code's supporting span; overlapping spans take the first code's color.
function highlight(text, codes) {
  const marks = new Array(text.length).fill(null);
  const lower = text.toLowerCase();
  for (const c of codes) {
    if (!c.span) continue;
    const i = lower.indexOf(c.span.toLowerCase());
    if (i < 0) continue;
    for (let k = i; k < i + c.span.length; k++) marks[k] ??= c.code;
  }
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = marks[i];
    let j = i;
    while (j < text.length && marks[j] === m) j++;
    const seg = esc(text.slice(i, j));
    out += m ? `<mark style="--c:${colorOf(m)}" title="${esc(m)}">${seg}</mark>` : seg;
    i = j;
  }
  return out;
}

function readFile(input) {
  return new Promise((resolve) => {
    const f = input.files[0];
    if (!f) return resolve(null);
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, text: r.result });
    r.readAsText(f);
  });
}

async function refresh() {
  state = await api("/api/state");
  const s = $("#status");
  const run = state.run ? `Last run ${new Date(state.run.finishedAt || state.run.startedAt).toLocaleString()} · ${state.run.coded} coded${state.run.errors ? ` · ${state.run.errors} errors` : ""}` : "No run yet";
  s.innerHTML = `${esc(state.adapter)}<br>${state.verbatimCount} verbatims · ${state.frame.length} codes · ${run}`;
  for (const b of document.querySelectorAll("#tabs button")) {
    b.classList.toggle("active", b.dataset.tab === tab);
    const badge = b.dataset.tab === "proposals" && state.proposalsPending ? `<span class="count">${state.proposalsPending}</span>` : "";
    b.innerHTML = b.textContent.replace(/\d+$/, "") + badge;
  }
}

// ---------- 1. Setup ----------
async function renderSetup(view) {
  view.innerHTML = `
    <h2>Setup</h2>
    <p class="lede">Load a code frame (code, label, description) and verbatims (id, question, text), or start from the bundled synthetic study: 200 answers about a fictional station's 6pm newscast, coded against a 12-code frame.</p>
    <div class="grid2">
      <div class="panel">
        <h3>Start a study</h3>
        <div class="row" style="margin-bottom:12px">
          <button class="btn primary" id="sample">Load synthetic sample</button>
          <span class="muted">or upload your own:</span>
        </div>
        <div class="row" style="margin-bottom:8px"><label class="btn">Code frame CSV<input type="file" id="frameFile" accept=".csv"></label><span class="muted" id="frameName">none chosen</span></div>
        <div class="row" style="margin-bottom:12px"><label class="btn">Verbatims CSV<input type="file" id="verbFile" accept=".csv"></label><span class="muted" id="verbName">none chosen</span></div>
        <div class="row"><button class="btn" id="upload">Load uploaded files</button></div>
        <p class="muted" style="font-size:12px;margin-top:12px">Loading new files starts a new study and clears earlier decisions and proposals.</p>
      </div>
      <div class="panel">
        <h3>Settings</h3>
        <div class="row" style="margin-bottom:12px">
          <label for="threshold">Auto-accept threshold</label>
          <input type="number" id="threshold" min="0" max="1" step="0.05" value="${state.threshold}" style="width:90px">
          <button class="btn small" id="saveThreshold">Save</button>
        </div>
        <p class="muted" style="font-size:12px;margin:-4px 0 14px">Codes with confidence below this go to the review queue.</p>
        <div class="row">
          <label for="adapter">Coder</label>
          <select id="adapter">${state.adapters.map((a) => `<option value="${a}" ${a === state.adapterName ? "selected" : ""}>${a === "anthropic" ? "Claude (Anthropic API)" : "Offline lexical baseline"}</option>`).join("")}</select>
        </div>
        <p class="muted" style="font-size:12px">Now using: ${esc(state.adapter)}</p>
      </div>
    </div>
    <div class="panel">
      <h3>Code frame${state.question ? ` · question: “${esc(state.question)}”` : ""}</h3>
      ${state.frame.length ? `<table><tr><th>Code</th><th>Label</th><th>Description</th><th>Origin</th></tr>
        ${state.frame.map((c) => `<tr><td><span class="chip" style="--c:${colorOf(c.code)}">${esc(c.code)}</span></td><td>${esc(c.label)}</td><td class="muted">${esc(c.description)}</td><td>${c.origin === "approved" ? '<span class="tag good">approved proposal</span>' : '<span class="tag">base</span>'}</td></tr>`).join("")}
      </table>` : `<div class="empty">No study loaded yet.</div>`}
    </div>`;
  $("#frameFile").onchange = (e) => ($("#frameName").textContent = e.target.files[0]?.name || "none chosen");
  $("#verbFile").onchange = (e) => ($("#verbName").textContent = e.target.files[0]?.name || "none chosen");
  $("#sample").onclick = guard(async () => {
    await api("/api/setup", { useSample: true, threshold: Number($("#threshold").value) });
    toast("Synthetic sample loaded");
    go("run");
  });
  $("#upload").onclick = guard(async () => {
    const [f, v] = [await readFile($("#frameFile")), await readFile($("#verbFile"))];
    if (!f || !v) throw new Error("Choose both a code frame CSV and a verbatims CSV");
    await api("/api/setup", { frameCsv: f.text, verbatimCsv: v.text, threshold: Number($("#threshold").value) });
    toast("Study loaded");
    go("run");
  });
  $("#saveThreshold").onclick = guard(async () => {
    await api("/api/threshold", { threshold: Number($("#threshold").value) });
    toast("Threshold saved");
    render();
  });
  $("#adapter").onchange = guard(async (e) => {
    await api("/api/adapter", { name: e.target.value });
    toast("Coder switched; run coding again to use it");
    render();
  });
}

// ---------- 2. Coding run ----------
async function renderRun(view) {
  const p = state.progress;
  const running = p?.running;
  view.innerHTML = `
    <h2>Coding run</h2>
    <p class="lede">Codes every verbatim against the current frame${state.frame.some((c) => c.origin === "approved") ? " (including approved proposals)" : ""}. Review decisions you've made override the model and survive re-runs.</p>
    <div class="panel row">
      <button class="btn primary" id="go" ${running || !state.verbatimCount ? "disabled" : ""}>${state.run ? "Re-run coding" : "Run coding"}</button>
      <div class="progress"><div style="width:${p ? (100 * p.done) / p.total : state.run ? 100 : 0}%"></div></div>
      <span class="muted" id="prog">${running ? `${p.done} / ${p.total} · ${Math.round((Date.now() - p.startedAt) / 1000)}s` : p?.finishedAt ? `Done in ${Math.round((p.finishedAt - p.startedAt) / 1000)}s` : ""}</span>
    </div>
    <div class="panel" id="table">${state.run ? "" : `<div class="empty">${state.verbatimCount ? "Run coding to see results." : "Load a study in Setup first."}</div>`}</div>`;
  $("#go").onclick = guard(async () => {
    await api("/api/run", {});
    await refresh();
    render();
  });
  if (running) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => { await refresh(); if (tab === "run") render(); }, 1000);
    return;
  }
  if (!state.run) return;
  const { rows, errors, threshold } = await api("/api/results");
  const errById = new Map(errors.map((e) => [e.id, e.error]));
  const draw = (q = "") => {
    const ql = q.toLowerCase();
    const shown = rows.filter((r) => !q || r.id.toLowerCase().includes(ql) || r.text.toLowerCase().includes(ql) || r.codes.some((c) => c.code.toLowerCase() === ql));
    $("#rows").innerHTML = shown.map((r) => `<tr>
        <td class="mono">${esc(r.id)}</td>
        <td>${highlight(r.text, r.codes)}${errById.has(r.id) ? `<div class="tag bad">${esc(errById.get(r.id))}</div>` : ""}</td>
        <td>${r.codes.map((c) => chip(c, { threshold })).join("") || '<span class="muted">uncoded</span>'}
          ${r.decided ? '<div><span class="tag good">human decision</span></div>' : ""}
          ${r.non_human ? `<div><span class="tag warn" title="${esc(r.non_human_reason)}">flagged non-human</span></div>` : ""}</td>
      </tr>`).join("");
    $("#shown").textContent = `${shown.length} of ${rows.length}`;
  };
  $("#table").innerHTML = `
    <div class="row" style="margin-bottom:10px"><input type="search" id="q" placeholder="Filter by text, id, or code" style="flex:1;min-width:200px"><span class="muted" id="shown"></span></div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Run by ${esc(state.run.adapter)}. Highlighted text is the span supporting each code; confidence below ${threshold} shows in amber. Dashed chips are human decisions.</div>
    <div class="scroll"><table><thead><tr><th style="width:60px">ID</th><th>Verbatim</th><th style="width:300px">Codes</th></tr></thead><tbody id="rows"></tbody></table></div>`;
  $("#q").oninput = (e) => draw(e.target.value);
  draw();
}

// ---------- 3. Review queue ----------
function codeEditor(row, onSave) {
  const el = document.createElement("div");
  el.className = "card";
  let codes = row.codes.map((c) => ({ ...c }));
  const draw = () => {
    el.innerHTML = `
      <div class="row"><span class="mono">${esc(row.id)}</span>${(row.reasons || []).map((r) => `<span class="tag ${/non-human|error/.test(r) ? "bad" : "warn"}">${esc(r)}</span>`).join("")}
        ${row.decided ? '<span class="tag good">decided</span>' : ""}</div>
      <div class="text">${highlight(row.text, codes)}</div>
      ${row.non_human ? `<div class="muted" style="font-size:12px;margin:-4px 0 8px">Non-human signal: ${esc(row.non_human_reason)}</div>` : ""}
      <div class="row">
        <div>${codes.map((c) => chip(c, { threshold: state.threshold, removable: true })).join("") || '<span class="muted">no codes</span>'}</div>
        <select class="add"><option value="">+ reassign / add code…</option>${state.frame.filter((f) => !codes.some((c) => c.code === f.code)).map((f) => `<option value="${esc(f.code)}">${esc(f.code)} · ${esc(f.label)}</option>`).join("")}</select>
        <span class="spacer"></span>
        <button class="btn small primary" data-act="accept">${row.decided ? "Save" : "Accept"}</button>
        <button class="btn small" data-act="reject">Reject all</button>
        ${row.decided ? '<button class="btn small" data-act="undo">Undo decision</button>' : ""}
      </div>`;
    el.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => { codes = codes.filter((c) => c.code !== b.dataset.remove); draw(); }));
    $(".add", el).onchange = (e) => {
      if (!e.target.value) return;
      const span = window.getSelection().toString().trim();
      codes.push({ code: e.target.value, span: row.text.includes(span) ? span : "", source: "human", confidence: null });
      draw();
    };
    el.querySelectorAll("[data-act]").forEach((b) => (b.onclick = guard(async () => {
      const act = b.dataset.act;
      if (act === "undo") await api("/api/decision", { id: row.id, undo: true });
      else await api("/api/decision", { id: row.id, codes: act === "reject" ? [] : codes.map((c) => ({ code: c.code, span: c.span })) });
      toast(act === "undo" ? `${row.id}: back to model output` : `${row.id}: decision saved`);
      onSave();
    })));
  };
  draw();
  return el;
}

async function renderReview(view) {
  if (!state.run) { view.innerHTML = `<h2>Review queue</h2><div class="empty">Run coding first.</div>`; return; }
  const { items, groups } = await api("/api/review");
  const open = items.filter((i) => !i.decided);
  view.innerHTML = `
    <h2>Review queue</h2>
    <p class="lede">Verbatims with a code below the ${state.threshold} threshold, no code, a span the model quoted that isn't in the text, or a non-human flag, plus groups of near-duplicates. Accept keeps the codes shown; remove a chip to reject one code; add a code to reassign (select text in the verbatim first to attach it as the span). Decisions persist for this study and override the model on every re-run.</p>
    <div class="stats">
      <div class="stat"><b>${open.length}</b><span>open items</span></div>
      <div class="stat"><b>${items.length - open.length}</b><span>decided</span></div>
      <div class="stat"><b>${items.filter((i) => i.non_human).length}</b><span>flagged non-human</span></div>
      <div class="stat"><b>${groups.length}</b><span>near-duplicate groups</span></div>
    </div>
    <div class="row" style="margin-bottom:10px"><label><input type="checkbox" id="showDecided"> Show decided items</label></div>
    <div id="items"></div>
    <h3>Near-duplicate groups</h3>
    <div id="groups">${groups.length ? "" : '<div class="empty">None found.</div>'}</div>`;
  const reload = () => renderReview(view);
  const drawItems = () => {
    const box = $("#items");
    box.innerHTML = "";
    const list = $("#showDecided").checked ? items : open;
    if (!list.length) box.innerHTML = `<div class="empty">Nothing waiting for review.</div>`;
    list.forEach((row) => box.appendChild(codeEditor(row, reload)));
  };
  $("#showDecided").onchange = drawItems;
  drawItems();
  for (const g of groups) {
    const card = document.createElement("div");
    card.className = "panel";
    card.innerHTML = `<div class="row"><b>${g.length} near-identical verbatims</b><span class="muted">${g.map((r) => r.id).join(", ")}</span><span class="spacer"></span>
      <button class="btn small" data-apply>Apply ${esc(g[0].id)}'s codes to all</button></div>`;
    g.forEach((row) => card.appendChild(codeEditor(row, reload)));
    $("[data-apply]", card).onclick = guard(async () => {
      const codes = g[0].codes.map((c) => ({ code: c.code, span: c.span }));
      for (const row of g) await api("/api/decision", { id: row.id, codes });
      toast("Group decided");
      reload();
    });
    $("#groups").appendChild(card);
  }
}

// ---------- 4. Frame proposals ----------
async function renderProposals(view) {
  const { proposals } = await api("/api/proposals");
  const pending = proposals.filter((p) => p.status === "pending");
  const resolved = proposals.filter((p) => p.status !== "pending");
  view.innerHTML = `
    <h2>Frame proposals</h2>
    <p class="lede">The coder looks at verbatims it put in “other”, left uncoded, or coded with low confidence, and proposes new codes for recurring themes. Approving adds the code to the frame for the next coding run. Rejecting sticks: the coder won't propose it again in this study.</p>
    <div class="panel row"><button class="btn primary" id="gen" ${state.run ? "" : "disabled"}>Propose codes</button><span class="muted">${state.run ? "" : "Run coding first."}</span></div>
    <div id="pending">${pending.length ? "" : '<div class="empty">No pending proposals.</div>'}</div>
    ${resolved.length ? `<h3>Resolved</h3><div class="panel"><table><tr><th>Code</th><th>Label</th><th>Status</th></tr>${resolved.map((p) => `<tr><td class="mono">${esc(p.code)}</td><td>${esc(p.label)}</td><td><span class="tag ${p.status === "approved" ? "good" : "bad"}">${p.status}</span></td></tr>`).join("")}</table></div>` : ""}`;
  $("#gen").onclick = guard(async () => {
    $("#gen").disabled = true;
    $("#gen").textContent = "Thinking…";
    const { added } = await api("/api/proposals/generate", {});
    toast(added.length ? `${added.length} new proposal(s)` : "No new themes found");
    await refresh();
    render();
  });
  for (const p of pending) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="row"><span class="chip mono">${esc(p.code)}</span><b>${esc(p.label)}</b><span class="spacer"></span>
        <button class="btn small primary" data-ok>Approve</button><button class="btn small" data-no>Reject</button></div>
      <p class="muted" style="margin:6px 0 10px">${esc(p.description)}</p>
      ${p.examples.map((e) => `<div style="margin-bottom:6px"><span class="mono muted">${esc(e.id)}</span> ${esc(e.text)}</div>`).join("")}`;
    const resolve = (approve) => guard(async () => {
      await api("/api/proposals/resolve", { code: p.code, approve });
      toast(approve ? `${p.code} added to the frame; re-run coding to apply it` : `${p.code} rejected for this study`);
      await refresh();
      render();
    });
    $("[data-ok]", card).onclick = resolve(true);
    $("[data-no]", card).onclick = resolve(false);
    $("#pending").appendChild(card);
  }
}

// ---------- 5. Export ----------
function barChart(freq, n) {
  const max = Math.max(1, ...freq.map((f) => f.count));
  const rowH = 26, labelW = 210, chartW = 420, valW = 90;
  const h = freq.length * rowH + 10;
  return `<svg viewBox="0 0 ${labelW + chartW + valW} ${h}" width="100%" style="max-width:${labelW + chartW + valW}px" role="img" aria-label="Code frequency">
    ${freq.map((f, i) => {
      const y = i * rowH + 4;
      const w = (chartW * f.count) / max;
      return `<text class="bar-label" x="${labelW - 8}" y="${y + 15}" text-anchor="end">${esc(f.label)}</text>
        <rect x="${labelW}" y="${y + 3}" width="${Math.max(w, 1)}" height="${rowH - 9}" rx="3" fill="${colorOf(f.code)}"></rect>
        <text class="bar-value" x="${labelW + w + 6}" y="${y + 15}">${f.count} · ${pct(f.count / n)}</text>`;
    }).join("")}
  </svg>`;
}

async function renderExport(view) {
  if (!state.run) { view.innerHTML = `<h2>Export</h2><div class="empty">Run coding first.</div>`; return; }
  const { frequency, n } = await api("/api/frequency");
  view.innerHTML = `
    <h2>Export</h2>
    <p class="lede">Final codes for the study: the model's output, overridden wherever a reviewer decided. The <span class="mono">source</span> column says which.</p>
    <div class="panel row">
      <a class="btn" href="/export/coded_long.csv">Coded CSV · long form</a>
      <a class="btn" href="/export/coded_wide.csv">Coded CSV · wide form</a>
      <a class="btn" href="/export/code_frequency.csv">Code-frequency summary</a>
    </div>
    <div class="panel">
      <h3>Code frequency · share of ${n} verbatims</h3>
      ${barChart(frequency, n)}
    </div>`;
}

// ---------- 6. Eval ----------
async function renderEval(view) {
  view.innerHTML = `
    <h2>Eval</h2>
    <p class="lede">Agreement between Kappa and a golden set (verbatim_id, code) coded independently of Kappa, ideally by people. Each verbatim × code is a yes/no call made by both coders. Cohen's κ corrects agreement for chance; 0 means no better than chance and 1 is perfect.</p>
    <div class="panel row">
      <button class="btn primary" id="sampleGold">Use synthetic golden set</button>
      <label class="btn">Upload golden CSV<input type="file" id="goldFile" accept=".csv"></label>
      <span class="spacer"></span>
      <label>Score <select id="mode"><option value="model">model output only</option><option value="final">final codes (with review decisions)</option></select></label>
    </div>
    <div id="out">${state.golden ? "" : '<div class="empty">Load a golden set to score this run.</div>'}</div>`;
  const run = guard(async (body) => {
    const r = await api("/api/eval", { ...body, mode: $("#mode").value });
    await refresh();
    drawEval(r);
  });
  $("#sampleGold").onclick = () => run({ useSample: true });
  $("#goldFile").onchange = async () => { const f = await readFile($("#goldFile")); if (f) run({ goldenCsv: f.text, name: f.name }); };
  $("#mode").onchange = () => state.golden && run({});
  if (state.golden && state.run) run({});
}

function drawEval(r) {
  const o = r.overall;
  const kClass = (k) => (k == null ? "" : k >= 0.8 ? "good" : k >= 0.6 ? "" : k >= 0.4 ? "warn" : "bad");
  $("#out").innerHTML = `
    <div class="muted" style="margin-bottom:10px">Scoring ${esc(r.mode)} from ${esc(r.adapter)} against ${esc(r.golden)} · ${r.n} verbatims${r.missingFromStudy.length ? ` · ${r.missingFromStudy.length} golden ids not in this study` : ""}</div>
    ${r.codesNotInGolden.length ? `<div class="panel" style="font-size:13px">Codes in the frame that never appear in the golden set: ${r.codesNotInGolden.map((c) => chip({ code: c })).join("")}
      If those are approved proposals, the golden coders never had them as an option, so every use counts as a disagreement (usually against OTHER).</div>` : ""}
    <div class="stats">
      <div class="stat"><b>${num(o.pooledKappa)}</b><span>Cohen's κ, pooled over all codes</span></div>
      <div class="stat"><b>${num(o.meanKappa)}</b><span>mean per-code κ</span></div>
      <div class="stat"><b>${pct(o.exactMatch)}</b><span>verbatims with identical code sets</span></div>
      <div class="stat"><b>${pct(o.precision)}</b><span>precision (model codes the golden set also has)</span></div>
      <div class="stat"><b>${pct(o.recall)}</b><span>recall (golden codes the model found)</span></div>
      <div class="stat"><b>${num(o.f1)}</b><span>F1</span></div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Per code</h3><div class="scroll"><table>
        <tr><th>Code</th><th class="num">Golden</th><th class="num">Model</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">Agree</th><th class="num">κ</th></tr>
        ${r.perCode.map((p) => `<tr><td><span class="chip" style="--c:${colorOf(p.code)}" title="${esc(p.label)}">${esc(p.code)}</span></td>
          <td class="num">${p.human}</td><td class="num">${p.model}</td><td class="num">${pct(p.precision)}</td><td class="num">${pct(p.recall)}</td>
          <td class="num">${pct(p.agreement)}</td><td class="num"><span class="tag ${kClass(p.kappa)}">${num(p.kappa)}</span></td></tr>`).join("")}
      </table></div></div>
      <div class="panel"><h3>Most confused pairs</h3>
        ${r.confusedPairs.length ? `<table><tr><th>Model said</th><th>Golden said</th><th class="num">Verbatims</th></tr>
          ${r.confusedPairs.map((c) => `<tr><td>${chip({ code: c.model })}</td><td>${chip({ code: c.human })}</td><td class="num">${c.count}</td></tr>`).join("")}</table>`
          : '<div class="empty">No confusions.</div>'}
        <p class="muted" style="font-size:12px">On the same verbatim, the model gave the first code and missed the second, which the golden set has.</p>
      </div>
    </div>
    ${r.nonHuman ? `<div class="panel"><h3>Non-human flag</h3>
      Caught <b>${r.nonHuman.caught} of ${r.nonHuman.actual}</b> verbatims written to read as machine-generated; ${r.nonHuman.flagged} flagged in total.
      ${r.nonHuman.falsePositives.length ? `<div class="muted">Flagged but written as human: ${r.nonHuman.falsePositives.map(esc).join(", ")}</div>` : ""}
      ${r.nonHuman.missed.length ? `<div class="muted">Missed: ${r.nonHuman.missed.map(esc).join(", ")}</div>` : ""}</div>` : ""}
    <h3>Disagreements (${r.disagreements.length})</h3>
    <div class="row" style="margin-bottom:10px"><label><input type="checkbox" id="onlyNotes"> Only verbatims with an authoring note (hard cases, machine-written)</label></div>
    <div id="dis"></div>`;
  const draw = () => {
    const only = $("#onlyNotes").checked;
    $("#dis").innerHTML = r.disagreements.filter((d) => !only || d.note).map((d) => `
      <div class="card">
        <div class="row"><span class="mono">${esc(d.id)}</span>
          ${d.modelOnly.map((c) => `<span class="tag warn">model only: ${esc(c)}</span>`).join("")}
          ${d.humanOnly.map((c) => `<span class="tag bad">missed: ${esc(c)}</span>`).join("")}</div>
        ${d.note ? `<div class="muted" style="font-size:12px;margin:6px 0">Authoring note: ${esc(d.note)}</div>` : ""}
        <div class="side" style="margin-top:8px">
          <div><div class="muted" style="font-size:12px">Golden set</div>${d.human.map((c) => chip({ code: c })).join("") || '<span class="muted">none</span>'}<div class="text">${esc(d.text)}</div></div>
          <div><div class="muted" style="font-size:12px">Kappa</div>${d.model.map((c) => chip(c)).join("") || '<span class="muted">none</span>'}<div class="text">${highlight(d.text, d.model)}</div></div>
        </div>
      </div>`).join("") || '<div class="empty">No disagreements.</div>';
  };
  $("#onlyNotes").onchange = draw;
  draw();
}

// ---------- shell ----------
const screens = { setup: renderSetup, run: renderRun, review: renderReview, proposals: renderProposals, export: renderExport, eval: renderEval };

async function render() {
  const view = $("#view");
  try {
    await screens[tab](view);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function go(t) {
  tab = screens[t] ? t : "setup";
  location.hash = tab;
  await refresh();
  render();
}

document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => go(b.dataset.tab)));
window.addEventListener("hashchange", () => location.hash.slice(1) !== tab && go(location.hash.slice(1)));
go(tab);
