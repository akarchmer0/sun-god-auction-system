import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIAutodraftService } from "../src/openai-autodraft-service.mjs";

const context = {
  player: { id: "runner", name: "Top Runner", position: "RB", suggestedValue: 30 },
  league: { budget: 200, rosterSize: 15, rosterRequirements: { RB: 2 }, soldCount: 1, availableCount: 100 },
  remainingByPosition: { RB: 20 },
  recentSales: [],
  teams: [
    { teamId: "a", teamName: "Alpha", manager: "Alex", budgetRemaining: 180, rosterSlotsRemaining: 14, maxLegalBid: 166, roster: [] },
    { teamId: "b", teamName: "Bravo", manager: "Blair", budgetRemaining: 150, rosterSlotsRemaining: 12, maxLegalBid: 139, roster: [] }
  ]
};
const fallbackDecisions = [
  { teamId: "a", intent: "target", reason: "required_position" },
  { teamId: "b", intent: "value", reason: "value_opportunity" }
];

test("unconfigured AI autodraft returns the local decision set", async () => {
  const service = new OpenAIAutodraftService({ fetchImpl: null, onError: () => {} });
  const result = await service.createIntents({ context, fallbackDecisions });
  assert.equal(result.provider, "local");
  assert.deepEqual(result.decisions, fallbackDecisions);
});

test("configured AI autodraft batches teams with strict structured output", async () => {
  let request;
  const decisions = [
    { teamId: "a", intent: "target", reason: "required_position" },
    { teamId: "b", intent: "pass", reason: "position_saturated" }
  ];
  const service = new OpenAIAutodraftService({
    apiKey: "test-key",
    model: "gpt-test",
    onError: () => {},
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ decisions }) }) };
    }
  });
  const result = await service.createIntents({ context, fallbackDecisions });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(request.body.reasoning, { effort: "none" });
  assert.equal(request.body.text.format.type, "json_schema");
  assert.deepEqual(request.body.text.format.schema.properties.decisions.items.properties.intent.enum, ["pass", "value", "target"]);
  assert.match(request.body.input, /"teamId":"a"/);
  assert.deepEqual(result, { decisions, provider: "openai", model: "gpt-test" });
});

test("incomplete or invalid model output falls back atomically", async () => {
  const service = new OpenAIAutodraftService({
    apiKey: "test-key",
    onError: () => {},
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ decisions: [{ teamId: "a", intent: "target", reason: "required_position" }] }) })
    })
  });
  const result = await service.createIntents({ context, fallbackDecisions });
  assert.equal(result.provider, "local");
  assert.deepEqual(result.decisions, fallbackDecisions);
});

test("AI autodraft timeout keeps local strategy available", async () => {
  const errors = [];
  const service = new OpenAIAutodraftService({
    apiKey: "test-key",
    timeoutMs: 20,
    onError: (message) => errors.push(message),
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });
  const result = await service.createIntents({ context, fallbackDecisions });
  assert.equal(result.provider, "local");
  assert.deepEqual(result.decisions, fallbackDecisions);
  assert.deepEqual(errors, []);
  assert.match(service.status().message, /optional 1-second strategy window.*local decisions stayed active/i);
});
