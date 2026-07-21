import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIPatterService } from "../src/openai-patter-service.mjs";

const context = { playerName: "Sample Receiver", position: "WR", amount: 28, nextAmount: 29, phase: "open" };

test("unconfigured Patter Director leaves local patter active", async () => {
  const service = new OpenAIPatterService({ fetchImpl: null, onError: () => {} });
  assert.equal(service.status().provider, "local");
  assert.deepEqual(await service.createPatter({ context }), { lines: [], provider: "local", model: null });
});

test("configured Patter Director requests a strict three-line queue", async () => {
  let request;
  const lines = [
    "Twenty-eight dollars and this room is shaking.",
    "Ari holds the lead but every budget is watching.",
    "Who brings twenty-nine and keeps this alive?"
  ];
  const service = new OpenAIPatterService({
    apiKey: "test-key",
    model: "gpt-test",
    onError: () => {},
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ lines }) }) };
    }
  });
  const result = await service.createPatter({ context, recentLines: ["Old line"], personality: "hype", energy: 3 });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(request.body.reasoning, { effort: "none" });
  assert.equal(request.body.text.verbosity, "low");
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.schema.properties.lines.minItems, 3);
  assert.match(request.body.input, /Old line/);
  assert.deepEqual(result.lines, lines);
  assert.equal(result.provider, "openai");
});

test("invalid model output falls back without blocking the auction", async () => {
  const service = new OpenAIPatterService({
    apiKey: "test-key",
    onError: () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: "not json" }) })
  });
  const result = await service.createPatter({ context });
  assert.equal(result.provider, "local");
  assert.deepEqual(result.lines, []);
});

test("Patter Director can wait in the background without delaying local speech", async () => {
  const service = new OpenAIPatterService({
    apiKey: "test-key",
    timeoutMs: 25,
    onError: () => {},
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });
  const startedAt = Date.now();
  const result = await service.createPatter({ context });
  assert.ok(Date.now() - startedAt >= 20);
  assert.deepEqual(result.lines, []);
  assert.equal(result.provider, "local");
});
