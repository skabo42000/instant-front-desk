import { expect, it } from "vitest";
import { answer } from "../../src/lib/answer";
import { GeminiAnswer } from "../../src/lib/models/providers";
import { ModelGateway } from "../../src/lib/models/gateway";

it.each([
  "You can always find the most up-to-date prices and deals on the booking page.",
  "Check the booking page [source] for up-to-date prices; walk-ins aren't listed—contact us (please).",
  "Prices/deals: check the booking page! It's up‑to‑date… Ask about offers? [1]",
])("preserves punctuation and citation markers through fake Gemini HTTP, gateway, answer and JSON: %s", async text => {
  const source = { id: "source", heading: "Prices and deals", pageUrl: "https://salon.example/", text };
  const adapter = new GeminiAnswer("synthetic-punctuation-key", async () => Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ text, citedChunkIds: [source.id] }) }] } }],
    usageMetadata: { promptTokenCount: 893, candidatesTokenCount: 65 },
  }));
  const gateway = new ModelGateway({ primary: { provider: "gemini", model: adapter.model, family: adapter.family, adapter } });
  const result = await answer("Where can I find current prices and deals?", [source], gateway);
  expect(JSON.parse(JSON.stringify(result))).toMatchObject({ kind: "answer", text, citations: [{ id: "source" }],
    logs: [{ outputTokens: 65 }] });
});
