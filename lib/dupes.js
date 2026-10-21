// Near-duplicate detection: Jaccard similarity on character 4-gram shingles of the
// normalized text (robust to case, punctuation and small respellings), grouped with union-find.

const MIN_CHARS = 25; // shorter answers ("good", "no comment") repeat naturally and are not duplicates

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

function shingles(text) {
  const t = normalize(text);
  const out = new Set();
  for (let i = 0; i + 4 <= t.length; i++) out.add(t.slice(i, i + 4));
  return out;
}

function jaccard(a, b) {
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

export function nearDuplicateGroups(verbatims, threshold = 0.45) {
  const sets = verbatims.map((v) => (normalize(v.text).length >= MIN_CHARS ? shingles(v.text) : null));
  const parent = verbatims.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < verbatims.length; i++) {
    if (!sets[i]) continue;
    for (let j = i + 1; j < verbatims.length; j++) {
      if (sets[j] && jaccard(sets[i], sets[j]) >= threshold) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  verbatims.forEach((v, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(v.id);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}
