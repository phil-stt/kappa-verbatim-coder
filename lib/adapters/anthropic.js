// Claude adapter for the Verbatim Coder. Uses the official SDK; credentials resolve the
// SDK's usual way (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.KAPPA_MODEL || "claude-opus-5-5";
const EFFORT = process.env.KAPPA_EFFORT || "low";

const SYSTEM = `You are the Verbatim Coder, an open-end coding assistant for a survey research team.
You assign codes from a code frame to survey verbatims (open-ended answers), the way a trained human coder would.

Rules:
- Assign every code the verbatim substantively supports. Multi-code is normal. Assign no code you cannot point to in the text.
- For each code, quote the supporting span: the shortest exact substring of the verbatim (copied character for character) that justifies the code.
- Confidence is your probability, 0 to 1, that a careful human coder would assign this code to this verbatim.
- If the code frame has a "nothing / no opinion" code, use it only for non-answers, and never alongside another code.
- Use an "other" code only for a substantive point no other code covers.
- Read sarcasm for its intended meaning, not its literal words.
- Flag non_human when the verbatim reads as machine-generated rather than written by a respondent (generic, balanced, polished, template-like, no lived detail). Give a short reason. Flag only with real signal; most verbatims are human.`;

function frameText(frame) {
  return frame.map((c) => `${c.code} | ${c.label} | ${c.description}`).join("\n");
}

function codingSchema(codes) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "codes", "non_human", "non_human_reason"],
          properties: {
            id: { type: "string" },
            codes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["code", "span", "confidence"],
                properties: {
                  code: { type: "string", enum: codes },
                  span: { type: "string" },
                  confidence: { type: "number" },
                },
              },
            },
            non_human: { type: "boolean" },
            non_human_reason: { type: "string" },
          },
        },
      },
    },
  };
}

const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "label", "description", "example_ids"],
        properties: {
          code: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          example_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export function createAnthropicAdapter() {
  const client = new Anthropic();

  async function call(system, user, schema) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal") throw new Error("The model declined this batch (refusal).");
    if (response.stop_reason === "max_tokens") throw new Error("The model ran out of output tokens on this batch.");
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { data: JSON.parse(text), usage: response.usage, model: response.model };
  }

  return {
    name: "anthropic",
    describe: () => `Claude (${MODEL}, effort ${EFFORT})`,

    async codeBatch({ frame, question, items }) {
      const system = `${SYSTEM}\n\nCode frame (code | label | description):\n${frameText(frame)}`;
      const user =
        `Survey question: "${question}"\n\nCode each verbatim below. Return one result per id, in the same order.\n\n` +
        items.map((v) => `[${v.id}] ${v.text}`).join("\n");
      const { data } = await call(system, user, codingSchema(frame.map((c) => c.code)));
      return data.results;
    },

    async propose({ frame, question, items, rejected }) {
      const system =
        `You help a survey research team maintain a code frame. You propose new codes only when a recurring theme ` +
        `in the verbatims is not covered by the existing frame.\n\nExisting code frame (code | label | description):\n${frameText(frame)}`;
      const user =
        `Survey question: "${question}"\n\nThese verbatims were coded "other", left uncoded, or coded with low confidence. ` +
        `Propose new codes for recurring themes (at least three verbatims each) that the existing frame does not cover. ` +
        `Use short uppercase code ids. For each, give exactly three example verbatim ids from the list. ` +
        `Propose nothing if there is no such theme.` +
        (rejected.length ? `\n\nThe team already rejected these proposals; do not propose them or close variants: ${rejected.join("; ")}` : "") +
        `\n\n` + items.map((v) => `[${v.id}] ${v.text}`).join("\n");
      const { data } = await call(system, user, proposalSchema);
      return data.proposals;
    },
  };
}
