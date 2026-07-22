import test from "node:test";
import assert from "node:assert/strict";
import { createDraft, nominatePlayer, openAuction, placeBid, maxBidForTeam } from "../src/domain.mjs";
import {
  buildAutoIntentContext,
  calculateAutoBidCeiling,
  chooseAutoBid,
  chooseAutoNomination,
  localAutoIntent,
  normalizeAutoIntents
} from "../src/autodraft.mjs";

const players = [
  { id: "runner", name: "Top Runner", position: "RB", nflTeam: "FA", suggestedValue: 30, status: "available" },
  { id: "receiver", name: "Top Receiver", position: "WR", nflTeam: "FA", suggestedValue: 24, status: "available" },
  { id: "kicker", name: "Early Kicker", position: "K", nflTeam: "FA", suggestedValue: 2, status: "available" }
];
const auto = (id) => ({
  id,
  name: `Team ${id}`,
  manager: `Manager ${id}`,
  color: "#d39a20",
  controller: { type: "auto", strategy: "balanced", aggressiveness: 1 },
  roster: []
});

function draft() {
  return createDraft({
    players,
    teams: [auto("a"), auto("b")],
    budget: 100,
    rosterSize: 6,
    increment: 1,
    rosterRequirements: { RB: 1, WR: 1, K: 1 }
  });
}

test("local strategy targets missing requirements and saves kicker for later", () => {
  const state = draft();
  assert.deepEqual(localAutoIntent(state, "a", "runner"), { intent: "target", reason: "required_position" });
  assert.deepEqual(localAutoIntent(state, "a", "kicker"), { intent: "target", reason: "required_position" });

  state.teams[0].roster = [{ playerId: "kicker", price: 1 }];
  assert.deepEqual(localAutoIntent(state, "a", "kicker"), { intent: "pass", reason: "late_round_depth" });
});

test("rules-based ceiling respects legal reserves and intent discounts", () => {
  const state = draft();
  const target = calculateAutoBidCeiling(state, "a", "runner", "target");
  const value = calculateAutoBidCeiling(state, "a", "runner", "value");
  assert.ok(target > value);
  assert.ok(target <= maxBidForTeam(state, "a"));
  assert.equal(calculateAutoBidCeiling(state, "a", "runner", "pass"), 0);
});

test("structured intents are accepted only for auto teams and known enums", () => {
  const state = openAuction(nominatePlayer(draft(), "runner"));
  const intents = normalizeAutoIntents(state, [
    { teamId: "a", intent: "pass", reason: "position_saturated" },
    { teamId: "b", intent: "target", reason: "player_fit" },
    { teamId: "stranger", intent: "target", reason: "player_fit" }
  ], { provider: "openai", model: "test-model" });
  assert.equal(intents.a.intent, "pass");
  assert.equal(intents.a.provider, "openai");
  assert.equal(intents.b.intent, "target");
  assert.equal(intents.stranger, undefined);
});

test("two auto teams stop bidding when their frozen ceilings are reached", () => {
  let state = openAuction(nominatePlayer(draft(), "runner"));
  state.auction.autoIntents = {
    a: { intent: "target", reason: "required_position" },
    b: { intent: "target", reason: "required_position" }
  };
  let bids = 0;
  while (chooseAutoBid(state)) {
    const decision = chooseAutoBid(state);
    state = placeBid(state, decision.teamId, decision.amount);
    bids += 1;
    assert.ok(bids < 100, "auto bidders should terminate");
  }
  assert.ok(bids > 0);
  assert.ok(bids < 6, "bot-versus-bot bidding should resolve with proxy-style jumps");
  assert.equal(chooseAutoBid(state), null);
});

test("auto nomination and model context reflect the current team construction", () => {
  const state = draft();
  assert.equal(chooseAutoNomination(state, "a"), "runner");
  const nominated = nominatePlayer(state, "runner");
  const context = buildAutoIntentContext(nominated);
  assert.equal(context.player.id, "runner");
  assert.equal(context.teams.length, 2);
  assert.equal(context.teams[0].rosterSlotsRemaining, 6);
  assert.equal(context.remainingByPosition.RB, 1);
});
