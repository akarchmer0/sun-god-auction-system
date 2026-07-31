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

test("configured service asks OpenAI to context-edit a candidate with structured output", async () => {
  let request;
  const service = new OpenAIRoastService({
    apiKey: "test-key",
    model: "gpt-test",
    onError: () => {},
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            text: "Ari just turned a $9 suggestion into a $28 cry for help.",
            priceAngle: "overpay",
            premiseSupported: true
          })
        })
      };
    }
  });
  const result = await service.createRoast({ context, recentRoasts: ["Already used"], personality: "pro" });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(request.body.model, "gpt-test");
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.reasoning, { effort: "none" });
  assert.equal(request.body.text.verbosity, "low");
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.strict, true);
  assert.match(request.body.instructions, /final context editor/);
  assert.match(request.body.instructions, /raw material, not an assignment/);
  assert.match(request.body.input, /Already used/);
  assert.match(request.body.input, /candidateJoke/);
  assert.match(request.body.input, /priceOutcome/);
  assert.equal(result.provider, "openai");
  assert.match(result.text, /\$28 cry for help/);
});

test("configured service stops cycling references and requests original roasts after ten sales", async () => {
  const instructions = [];
  const service = new OpenAIRoastService({
    apiKey: "test-key",
    onError: () => {},
    fetchImpl: async (_url, options) => {
      instructions.push(JSON.parse(options.body).instructions);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            text: "Ari saw the sheet, ignored it, and set nineteen dollars on fire.",
            priceAngle: "overpay",
            premiseSupported: true
          })
        })
      };
    }
  });
  const results = [];
  for (let index = 0; index < 12; index += 1) results.push(await service.createRoast({ context }));
  assert.match(instructions[9], /raw material, not an assignment/);
  assert.match(instructions[10], /Invent a new premise from the supplied auction facts/);
  assert.match(instructions[11], /Invent a new premise from the supplied auction facts/);
  assert.equal(results[9].referenceIndex, 9);
  assert.equal(results[10].referenceIndex, null);
  assert.equal(results[11].referenceIndex, null);
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
  assert.match(result.text, /19 dollars over/);
});

test("contradictory OpenAI edits are rejected for a context-safe fallback", async () => {
  const discountContext = {
    ...context,
    playerName: "Jaxon Smith-Njigba",
    position: "WR",
    amount: 31,
    suggestedValue: 44
  };
  const errors = [];
  const service = new OpenAIRoastService({
    apiKey: "test-key",
    onError: (message) => errors.push(message),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          text: "JSN is a sleeper and Ari wildly overpaid.",
          priceAngle: "overpay",
          premiseSupported: true
        })
      })
    })
  });
  const result = await service.createRoast({ context: discountContext });
  assert.equal(result.provider, "curated");
  assert.match(result.text, /13 dollars below/);
  assert.doesNotMatch(result.text, /sleeper|overpaid/i);
  assert.match(errors[0], /did not match the sale context/i);
});
