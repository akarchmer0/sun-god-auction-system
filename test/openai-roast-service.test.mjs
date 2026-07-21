import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRoastService } from "../src/openai-roast-service.mjs";

const context = {
  managerName: "Ari",
  fantasyTeamName: "Fourth and Wrong",
  playerName: "Sample Tight End",
  position: "TE",
  amount: 28,
  suggestedValue: 9
};

test("unconfigured roast service keeps the contextual rotation available", async () => {
  const service = new OpenAIRoastService({ fetchImpl: null, onError: () => {} });
  assert.equal(service.status().provider, "curated");
  const first = await service.createRoast({ context });
  const second = await service.createRoast({ context });
  assert.equal(first.provider, "curated");
  assert.equal(first.referenceIndex, 0);
  assert.equal(second.referenceIndex, 1);
  assert.notEqual(first.text, second.text);
});

test("configured service calls the Responses API with a selected reference and low verbosity", async () => {
  let request;
  const service = new OpenAIRoastService({
    apiKey: "test-key",
    model: "gpt-test",
    onError: () => {},
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ output: [{ content: [{ type: "output_text", text: "Ari just turned a $9 suggestion into a $28 cry for help." }] }] })
      };
    }
  });
  const result = await service.createRoast({ context, recentRoasts: ["Already used"], personality: "pro" });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(request.body.model, "gpt-test");
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.reasoning, { effort: "none" });
  assert.deepEqual(request.body.text, { verbosity: "low" });
  assert.match(request.body.instructions, /selected reference/);
  assert.match(request.body.input, /Already used/);
  assert.equal(result.provider, "openai");
  assert.match(result.text, /\$28 cry for help/);
});

test("API failures fall back to the selected curated line", async () => {
  const service = new OpenAIRoastService({
    apiKey: "test-key",
    onError: () => {},
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: "nope" }) })
  });
  const result = await service.createRoast({ context });
  assert.equal(result.provider, "curated");
  assert.equal(result.referenceIndex, 0);
  assert.match(result.text, /Ari is spending/);
});
