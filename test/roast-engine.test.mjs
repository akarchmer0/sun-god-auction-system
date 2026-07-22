import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoastInput,
  buildRoastInstructions,
  curatedRoast,
  extractResponseText,
  normalizeRoastContext,
  ROAST_REFERENCE_LINES,
  shouldRoastSale
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

test("roasts only trigger on strict overpays", () => {
  assert.equal(shouldRoastSale({ amount: 10, suggestedValue: 9 }), true);
  assert.equal(shouldRoastSale({ amount: 10, suggestedValue: 10 }), false);
  assert.equal(shouldRoastSale({ amount: 9, suggestedValue: 10 }), false);
  assert.equal(shouldRoastSale({ amount: 10 }), false);
});

test("roast prompt deliberately rotates the supplied house lines without sanitizing dark comedy", () => {
  const instructions = buildRoastInstructions({ personality: "hype", referenceIndex: 4 });
  assert.match(instructions, /\$28 on a rookie TE/);
  assert.match(instructions, /Profanity, vulgarity, and obvious hyperbole about death, drugs, injury/);
  assert.match(instructions, /Do not sanitize/);
  assert.match(instructions, /Do not invent actual news, injuries, rookie status, ADP, coach quotes/);
  assert.match(instructions, /high-energy, theatrical, dark, and viciously punchy/);
  for (const line of ROAST_REFERENCE_LINES) assert.ok(instructions.includes(line));
});

test("roast prompt switches to original dark jokes after the reference calibration", () => {
  const instructions = buildRoastInstructions({ personality: "classic", referenceIndex: null });
  assert.match(instructions, /Invent a genuinely new dark premise and punchline/);
  assert.match(instructions, /Do not recycle, paraphrase, or merely swap names/);
  assert.doesNotMatch(instructions, /selected reference is the rotation assignment/);
});

test("roast input contains normalized auction context and up to twenty recent lines", () => {
  const history = Array.from({ length: 24 }, (_, index) => `Old roast ${index}`);
  const payload = JSON.parse(buildRoastInput(context, history));
  assert.equal(payload.auctionContext.managerName, "Ari");
  assert.equal(payload.auctionContext.differenceFromSuggested, 19);
  assert.equal(payload.recentRoasts.length, 20);
  assert.equal(payload.recentRoasts[0], "Old roast 4");
  assert.equal(payload.recentRoasts.at(-1), "Old roast 23");
});

test("curated fallback follows the same ten-line contextual rotation", () => {
  assert.match(curatedRoast(context, 0), /Ari is spending/);
  assert.match(curatedRoast(context, 2), /hoping the starter dies/);
  assert.match(curatedRoast(context, 3), /higher than Ari was/);
  assert.match(curatedRoast(context, 4), /\$28 on a TE/);
  assert.match(curatedRoast(context, 5), /walking boot and last rites/);
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
