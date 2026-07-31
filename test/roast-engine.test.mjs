import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoastInput,
  buildRoastInstructions,
  curatedRoast,
  extractResponseText,
  normalizeRoastContext,
  parseRoastResponse,
  roastMatchesContext,
  ROAST_RESPONSE_FORMAT,
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

test("every completed sale is eligible for a roast", () => {
  assert.equal(shouldRoastSale({ amount: 10, suggestedValue: 9 }), true);
  assert.equal(shouldRoastSale({ amount: 10, suggestedValue: 10 }), true);
  assert.equal(shouldRoastSale({ amount: 9, suggestedValue: 10 }), true);
  assert.equal(shouldRoastSale({ amount: 10 }), true);
  assert.equal(shouldRoastSale({ amount: 0 }), false);
});

test("roast prompt treats house lines as editable style references", () => {
  const instructions = buildRoastInstructions({ personality: "hype", referenceIndex: 4 });
  assert.match(instructions, /Profanity, vulgarity, and obvious hyperbole about death, drugs, injury/);
  assert.match(instructions, /raw material, not an assignment/);
  assert.match(instructions, /discount.*never accuse the buyer of overpaying/is);
  assert.match(instructions, /premium or high.*never call the player a sleeper/is);
  assert.match(instructions, /Do not invent actual news, injuries, rookie status, ADP, coach quotes/);
  assert.match(instructions, /high-energy, theatrical, dark, and viciously punchy/);
  for (const line of ROAST_REFERENCE_LINES) assert.ok(instructions.includes(line));
});

test("roast prompt switches to original dark jokes after the reference calibration", () => {
  const instructions = buildRoastInstructions({ personality: "classic", referenceIndex: null });
  assert.match(instructions, /Invent a new premise from the supplied auction facts/);
  assert.doesNotMatch(instructions, /raw material, not an assignment/);
});

test("roast input contains explicit price semantics, a candidate, and recent lines", () => {
  const history = Array.from({ length: 24 }, (_, index) => `Old roast ${index}`);
  const payload = JSON.parse(buildRoastInput(context, history, "Candidate line"));
  assert.equal(payload.auctionContext.managerName, "Ari");
  assert.equal(payload.auctionContext.differenceFromSuggested, 19);
  assert.equal(payload.auctionContext.priceOutcome, "overpay");
  assert.equal(payload.auctionContext.projectedValueTier, "low");
  assert.match(payload.auctionContext.priceSummary, /19 above/);
  assert.equal(payload.candidateJoke, "Candidate line");
  assert.equal(payload.recentRoasts.length, 20);
  assert.equal(payload.recentRoasts[0], "Old roast 4");
  assert.equal(payload.recentRoasts.at(-1), "Old roast 23");
});

test("curated fallback follows the actual price outcome", () => {
  assert.match(curatedRoast(context, 0), /\$28.*19 dollars over/);
  assert.match(curatedRoast(context, 2), /\$9.*\$28|28.*arithmetic/);
  assert.match(curatedRoast(context, 9), /budget.*funeral/);
  assert.notEqual(curatedRoast(context, 10), curatedRoast(context, 9));

  const discount = { ...context, playerName: "Jaxon Smith-Njigba", amount: 31, suggestedValue: 44 };
  assert.match(curatedRoast(discount, 0), /13 dollars below/);
  assert.match(curatedRoast(discount, 7), /steal/);
  assert.doesNotMatch(curatedRoast(discount, 0), /overpaid|sleeper/i);

  const fair = { ...context, amount: 9, suggestedValue: 9 };
  assert.match(curatedRoast(fair, 0), /exactly the sheet price/);
});

test("missing suggested values are represented as unknown instead of zero-dollar facts", () => {
  const normalized = normalizeRoastContext({ ...context, suggestedValue: undefined });
  assert.equal(normalized.hasSuggestedValue, false);
  assert.equal(normalized.differenceFromSuggested, null);
  assert.equal(normalized.priceOutcome, "unknown");
  assert.doesNotMatch(curatedRoast(normalized, 3), /0-dollar suggestion/);
});

test("structured Responses API output is parsed and cleaned for speech", () => {
  const output = JSON.stringify({
    text: "Ari just turned a $9 suggestion into a $28 cry for help.",
    priceAngle: "overpay",
    premiseSupported: true
  });
  const payload = { output: [{ content: [{ type: "output_text", text: output }] }] };
  assert.deepEqual(parseRoastResponse(payload), {
    text: "Ari just turned a $9 suggestion into a $28 cry for help.",
    priceAngle: "overpay",
    premiseSupported: true
  });
  assert.equal(extractResponseText(payload), "Ari just turned a $9 suggestion into a $28 cry for help.");
  assert.equal(ROAST_RESPONSE_FORMAT.strict, true);
});

test("semantic guard rejects sleeper and overpay premises that contradict the sale", () => {
  const jsnDiscount = {
    ...context,
    playerName: "Jaxon Smith-Njigba",
    amount: 31,
    suggestedValue: 44
  };
  assert.equal(roastMatchesContext("JSN at $31? That's not a sleeper, that's a coma patient.", jsnDiscount), false);
  assert.equal(roastMatchesContext("Ari overpaid for JSN and lit the budget on fire.", jsnDiscount), false);
  assert.equal(roastMatchesContext("The room let JSN go thirteen dollars below the sheet; Ari just committed robbery.", jsnDiscount), true);
  assert.equal(roastMatchesContext("Ari got a massive bargain.", context), false);
});
