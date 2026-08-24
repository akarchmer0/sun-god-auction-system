import test from "node:test";
import assert from "node:assert/strict";
import { createDraft, nominatePlayer, openAuction, placeBid, maxBidForTeam } from "../src/domain.mjs";
import {
  buildAutoIntentContext,
  autoBidDelayMs,
  calculateAutoBidCeiling,
  chooseAutoBid,
  chooseAutoNomination,
  localAutoIntent,
  normalizeAutoIntents,
  sampledAutoBidValue
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

  state.players.push({ id: "bench-runner", name: "Bench Runner", position: "RB", nflTeam: "FA", suggestedValue: 5, status: "sold" });
  state.teams[0].roster = [{ playerId: "bench-runner", price: 1 }];
  assert.deepEqual(localAutoIntent(state, "a", "runner"), { intent: "value", reason: "value_opportunity" });

  state.teams[0].roster = [{ playerId: "kicker", price: 1 }];
  assert.deepEqual(localAutoIntent(state, "a", "kicker"), { intent: "pass", reason: "late_round_depth" });
});

test("local strategy uses discounted bench depth instead of stalling before the roster is full", () => {
  const state = draft();
  state.players.push(
    { id: "runner-two", name: "Runner Two", position: "RB", nflTeam: "FA", suggestedValue: 8, status: "sold" },
    { id: "runner-three", name: "Runner Three", position: "RB", nflTeam: "FA", suggestedValue: 7, status: "sold" },
    { id: "runner-four", name: "Runner Four", position: "RB", nflTeam: "FA", suggestedValue: 6, status: "available" }
  );
  state.teams[0].roster = [
    { playerId: "runner", price: 10 },
    { playerId: "runner-two", price: 5 },
    { playerId: "runner-three", price: 4 }
  ];
  assert.deepEqual(localAutoIntent(state, "a", "runner-four"), { intent: "discount", reason: "position_saturated" });
});

test("intent maximums use the specified normal distributions", () => {
  assert.equal(sampledAutoBidValue(100, "pass", 10), 0);
  assert.equal(sampledAutoBidValue(100, "discount", 0), 90);
  assert.equal(sampledAutoBidValue(100, "value", 0), 100);
  assert.equal(sampledAutoBidValue(100, "target", 0), 110);
  assert.equal(sampledAutoBidValue(100, "value", 1), 105);
  assert.equal(sampledAutoBidValue(100, "value", -1), 95);
});

test("sampled maximums are stable and respect the legal roster reserve", () => {
  const state = draft();
  const discount = calculateAutoBidCeiling(state, "a", "runner", "discount");
  const target = calculateAutoBidCeiling(state, "a", "runner", "target");
  const value = calculateAutoBidCeiling(state, "a", "runner", "value");
  assert.equal(calculateAutoBidCeiling(state, "a", "runner", "value"), value);
  assert.ok(target > value);
  assert.ok(value > discount);
  assert.ok(target <= maxBidForTeam(state, "a"));
  assert.equal(calculateAutoBidCeiling(state, "a", "runner", "pass"), 0);
});

test("Yahoo average remains context and does not replace the opponent suggested-value anchor", () => {
  const projectedState = draft();
  const marketState = draft();
  marketState.players.find((player) => player.id === "runner").marketAverage = 60;
  const projectedCeiling = calculateAutoBidCeiling(projectedState, "a", "runner", "value");
  const marketCeiling = calculateAutoBidCeiling(marketState, "a", "runner", "value");
  assert.equal(marketCeiling, projectedCeiling);
});

test("auto bidders make varied legal jumps without exceeding their ceiling", () => {
  let state = openAuction(nominatePlayer(draft(), "runner"));
  state.auction.autoIntents = {
    a: { intent: "pass", reason: "roster_balance" },
    b: { intent: "value", reason: "value_opportunity" }
  };
  const amounts = Array.from({ length: 16 }, (_, bidCount) => chooseAutoBid({
    ...state,
    auction: { ...state.auction, bidCount }
  }, { b: 20 }).amount);

  assert.ok(amounts.every((amount) => amount >= 2 && amount <= 4));
  assert.ok(amounts.some((amount) => amount > 2));
  assert.ok(new Set(amounts).size > 1);

  state.auction.amount = 19;
  const finalDecision = chooseAutoBid(state, { b: 20 });
  assert.equal(finalDecision.amount, 20);
  assert.equal(finalDecision.ceiling, 20);
});

test("auto bidders wait a varied few seconds before reacting", () => {
  const state = openAuction(nominatePlayer(draft(), "runner"));
  const delays = Array.from({ length: 12 }, (_, bidCount) => autoBidDelayMs({
    ...state,
    auction: { ...state.auction, bidCount }
  }, "b"));

  assert.ok(delays.every((delay) => delay >= 2_000 && delay <= 5_000));
  assert.ok(new Set(delays).size > 1);
  assert.equal(autoBidDelayMs(state, "b"), autoBidDelayMs(state, "b"));
});

test("a passing auto nominator remains committed at one dollar but never raises", () => {
  let state = openAuction(nominatePlayer(draft(), "runner"));
  state.auction.autoIntents = {
    a: { intent: "pass", reason: "roster_balance" },
    b: { intent: "pass", reason: "roster_balance" }
  };
  assert.equal(state.auction.highBidderId, "a");
  assert.equal(calculateAutoBidCeiling(state, "a", "runner", "pass"), 1);
  assert.equal(chooseAutoBid(state), null);
});

test("structured intents are accepted only for auto teams and known enums", () => {
  const state = openAuction(nominatePlayer(draft(), "runner"));
  const intents = normalizeAutoIntents(state, [
    { teamId: "a", intent: "pass", reason: "position_saturated" },
    { teamId: "b", intent: "discount", reason: "player_fit" },
    { teamId: "stranger", intent: "target", reason: "player_fit" }
  ], { provider: "openai", model: "test-model" });
  assert.equal(intents.a.intent, "pass");
  assert.equal(intents.a.provider, "openai");
  assert.equal(intents.b.intent, "discount");
  assert.equal(intents.stranger, undefined);
});

test("two auto teams make bounded jumps and stop at their frozen maximums", () => {
  let state = openAuction(nominatePlayer(draft(), "runner"));
  state.auction.autoIntents = {
    a: { intent: "target", reason: "required_position" },
    b: { intent: "target", reason: "required_position" }
  };
  let bids = 0;
  while (chooseAutoBid(state)) {
    const decision = chooseAutoBid(state);
    assert.ok(decision.amount >= state.auction.amount + 1);
    assert.ok(decision.amount <= state.auction.amount + 3);
    assert.ok(decision.amount <= decision.ceiling);
    state = placeBid(state, decision.teamId, decision.amount);
    bids += 1;
    assert.ok(bids < 100, "auto bidders should terminate");
  }
  assert.ok(bids > 0);
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
