// Offline baseline adapter: keyword matching against the code frame's own labels and
// descriptions. No network, no model. It exists so Kappa runs without credentials and so
// the eval panel has a floor to compare the LLM against. Expect it to score well below Claude.

const STOP = new Set(
  ("a an the and or but if of on in to for with at by from as is are was were be been being it its this that these those " +
   "i me my we our you your he she they them their his her not no so too very just about into over than then there here " +
   "what which who whom how when where why all any some more most other such only own same can will would should could " +
   "do does did done have has had having comments comment whether e g eg viewer viewers own " +
   "like good great really news newscast last night think thought show watch watched also even much get got one").split(" ")
);

const NON_ANSWER = /^(no|nope|none|nothing|n\/?a|na|idk|dunno|no comment|no opinion|not sure|don'?t know|didn'?t (watch|see)|did not (watch|see)|-+|\.+|\?+)\b/i;

const MACHINE_MARKERS = [
  "overall", "additionally", "furthermore", "moreover", "in conclusion", "comprehensive", "room for improvement",
  "it is worth noting", "well-structured", "informative", "provided a", "a balanced", "valuable", "engaging",
  "in summary", "notably", "effectively", "overall experience",
];

function stem(w) {
  return w.replace(/(ing|ed|es|s|ly)$/, "").replace(/(.)\1$/, "$1");
}

function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).map((w) => w.replace(/'s$/, "").replace(/'/g, ""));
}

function keywordsFor(code) {
  const words = tokens(`${code.label} ${code.description}`).filter((w) => w.length > 2 && !STOP.has(w));
  return new Set(words.map(stem));
}

function clauses(text) {
  const out = [];
  const re = /[^.!?;,\n]+[.!?;,\n]?/g;
  let m;
  while ((m = re.exec(text))) if (m[0].trim()) out.push(m[0].trim());
  return out.length ? out : [text];
}

function nonHuman(text) {
  const lower = text.toLowerCase();
  const hits = MACHINE_MARKERS.filter((m) => lower.includes(m));
  const words = tokens(text).length;
  const tidy = /^[A-Z]/.test(text.trim()) && /[.!]$/.test(text.trim()) && !/\b(u|ur|lol|idk|gonna|wanna)\b/i.test(text);
  if (hits.length >= 2 && words >= 25 && tidy) return { flag: true, reason: `polished, generic phrasing (${hits.slice(0, 3).join(", ")})` };
  return { flag: false, reason: "" };
}

export function createLexicalAdapter() {
  return {
    name: "lexical",
    describe: () => "Offline lexical baseline (keyword match on the code frame; no model)",

    async codeBatch({ frame, items }) {
      const kw = frame.map((c) => ({ code: c.code, words: keywordsFor(c) }));
      const noneCode = frame.find((c) => /no opinion|nothing/i.test(c.label))?.code;
      const otherCode = frame.find((c) => /^other$/i.test(c.label))?.code;
      return items.map((v) => {
        const parts = clauses(v.text);
        const codes = [];
        for (const { code, words } of kw) {
          if (code === noneCode || code === otherCode) continue;
          let best = null;
          let total = 0;
          for (const part of parts) {
            const n = tokens(part).map(stem).filter((w) => words.has(w)).length;
            total += n;
            if (n && (!best || n > best.n)) best = { part, n };
          }
          if (best) codes.push({ code, span: best.part, confidence: Math.min(0.95, 1 - Math.pow(0.5, total)) });
        }
        if (!codes.length) {
          const t = v.text.trim();
          if (noneCode && (NON_ANSWER.test(t) || tokens(t).length <= 2)) codes.push({ code: noneCode, span: t, confidence: 0.7 });
          else if (otherCode) codes.push({ code: otherCode, span: t, confidence: 0.3 });
        }
        const nh = nonHuman(v.text);
        return { id: v.id, codes, non_human: nh.flag, non_human_reason: nh.reason };
      });
    },

    async propose({ frame, items, rejected }) {
      const frameWords = new Set(frame.flatMap((c) => [...keywordsFor(c)]));
      const rejectedWords = new Set(rejected.flatMap((r) => tokens(r).map(stem)));
      const df = new Map();
      for (const v of items) {
        for (const w of new Set(tokens(v.text).filter((w) => w.length > 3 && !STOP.has(w)).map(stem))) {
          if (frameWords.has(w) || rejectedWords.has(w)) continue;
          if (!df.has(w)) df.set(w, []);
          df.get(w).push(v);
        }
      }
      const taken = new Set();
      const proposals = [];
      for (const [w, vs] of [...df.entries()].sort((a, b) => b[1].length - a[1].length)) {
        if (vs.length < 3 || proposals.length >= 3) break;
        const fresh = vs.filter((v) => !taken.has(v.id));
        if (fresh.length < 3) continue;
        fresh.forEach((v) => taken.add(v.id));
        proposals.push({
          code: w.toUpperCase().slice(0, 12),
          label: `Mentions of "${w}"`,
          description: `Verbatims that talk about ${w}. Proposed by keyword frequency among other/uncoded verbatims; rename before approving.`,
          example_ids: fresh.slice(0, 3).map((v) => v.id),
        });
      }
      return proposals;
    },
  };
}
