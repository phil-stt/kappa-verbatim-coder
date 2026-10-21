// Adapter selection. Every adapter implements:
//   describe() -> string
//   codeBatch({ frame, question, items }) -> [{ id, codes: [{ code, span, confidence }], non_human, non_human_reason }]
//   propose({ frame, question, items, rejected }) -> [{ code, label, description, example_ids }]
// KAPPA_ADAPTER=anthropic|lexical picks one; the default is anthropic.
import { createAnthropicAdapter } from "./anthropic.js";
import { createLexicalAdapter } from "./lexical.js";

const factories = { anthropic: createAnthropicAdapter, lexical: createLexicalAdapter };

export const adapterNames = Object.keys(factories);

export function createAdapter(name = process.env.KAPPA_ADAPTER || "anthropic") {
  const make = factories[name];
  if (!make) throw new Error(`Unknown adapter "${name}"; use one of ${adapterNames.join(", ")}`);
  return make();
}
