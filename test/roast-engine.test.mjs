import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoastInput,
  buildRoastInstructions,
  curatedRoast,
  extractResponseText,
  normalizeRoastContext,
  ROAST_REFERENCE_LINES
} from "../src/roast-engine.mjs";

const context = {
  managerName: "Ari",
  fantasyTeamName: "Fourth and Wrong",
  playerName: "Sample Tight End",
  position: "TE",
  nflTeam: "NYJ",
  amount: 28,
  suggestedValue: 9,
  budgetRemaining: 103,
  rosterCount: 4,
  rosterSize: 15,
  roster: [{ name: "Sample Runner", position: "RB", nflTeam: "NYJ", price: 31 }]
};

test("roast prompt deliberately rotates the supplied house lines and forbids invented facts", () => {
  const instructions = buildRoastInstructions({ personality: "hype", referenceIndex: 4 });
  assert.match(instructions, /\$28 on a rookie TE/);
  assert.match(instructions, /Do not invent an injury, rookie status, ADP, coach quote/);
  assert.match(instructions, /high-energy, theatrical, and punchy/);
  for (const line of ROAST_REFERENCE_LINES) assert.ok(instructions.includes(line));
});

test("roast input contains only normalized auction context and recent lines", () => {
  const payload = JSON.parse(buildRoastInput(context, ["Old roast"]));
  assert.equal(payload.auctionContext.managerName, "Ari");
  assert.equal(payload.auctionContext.differenceFromSuggested, 19);
  assert.deepEqual(payload.recentRoasts, ["Old roast"]);
});

test("curated fallback follows the same ten-line contextual rotation", () => {
  assert.match(curatedRoast(context, 0), /Ari is spending/);
  assert.match(curatedRoast(context, 4), /\$28 on a TE/);
  assert.match(curatedRoast(context, 9), /28.*9-dollar suggestion/);
  assert.notEqual(curatedRoast(context, 10), curatedRoast(context, 9));
});

test("missing suggested values are represented as unknown instead of zero-dollar facts", () => {
  const normalized = normalizeRoastContext({ ...context, suggestedValue: undefined });
  assert.equal(normalized.hasSuggestedValue, false);
  assert.equal(normalized.differenceFromSuggested, null);
  assert.doesNotMatch(curatedRoast(normalized, 3), /0-dollar suggestion/);
});

test("Responses API output text is extracted and cleaned for speech", () => {
  assert.equal(extractResponseText({
    output: [{ content: [{ type: "output_text", text: 'Roast: “Ari paid $28 for a depth-chart screensaver.”' }] }]
  }), "Ari paid $28 for a depth-chart screensaver.");
});
