import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPatterInstructions,
  normalizePatterContext,
  normalizePatterLines,
  parsePatterResponse
} from "../src/patter-director.mjs";

test("Patter Director prompt demands momentum without accent imitation or invented facts", () => {
  const prompt = buildPatterInstructions({ personality: "hype", energy: 3 });
  assert.match(prompt, /exactly one short, funny spoken phrase/);
  assert.match(prompt, /playful punchline/);
  assert.match(prompt, /Latin American soccer commentary/);
  assert.match(prompt, /Do not imitate an accent/);
  assert.match(prompt, /Never invent injuries/);
  assert.match(prompt, /Never say going once/);
});

test("live patter context is bounded and normalized", () => {
  const context = normalizePatterContext({
    phase: "once",
    playerName: "Sample Receiver",
    position: "wr",
    amount: 27.6,
    nextAmount: 29,
    bidCount: 4,
    roster: Array.from({ length: 30 }, (_, index) => ({ name: `Player ${index}`, position: "rb", price: index }))
  });
  assert.equal(context.position, "WR");
  assert.equal(context.amount, 28);
  assert.equal(context.roster.length, 18);
  assert.equal(context.bidCount, 4);
});

test("invalid countdown language rejects the entire model queue", () => {
  assert.deepEqual(normalizePatterLines(["Going once at twenty-eight."]), []);
  assert.deepEqual(normalizePatterLines(["Twenty-eight has the room buzzing.", "Who makes it twenty-nine?"]), []);
  assert.deepEqual(normalizePatterLines(["The room is quiet. Every budget is hiding."]), []);
  const payload = { output_text: JSON.stringify({ lines: [
    "Who brings twenty-nine and keeps this alive?"
  ] }) };
  assert.equal(parsePatterResponse(payload).length, 1);
});
