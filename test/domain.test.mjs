import test from "node:test";
import assert from "node:assert/strict";
import {
  createDraft,
  nominatePlayer,
  openAuction,
  placeBid,
  advanceCountdown,
  maxBidForTeam,
  moveToNextPlayer,
  undoLastSale
} from "../src/domain.mjs";

const players = [
  { id: "puka", name: "Puka Nacua", position: "WR", nflTeam: "LAR", suggestedValue: 42, status: "available" },
  { id: "bijan", name: "Bijan Robinson", position: "RB", nflTeam: "ATL", suggestedValue: 55, status: "available" }
];
const teams = [
  { id: "a", name: "Alpha", manager: "Alex", color: "orange", budget: 20, roster: [] },
  { id: "b", name: "Bravo", manager: "Blair", color: "blue", budget: 20, roster: [] }
];

function liveDraft() {
  let draft = createDraft({ players, teams, budget: 20, rosterSize: 3, increment: 1 });
  draft = nominatePlayer(draft, "puka");
  return openAuction(draft);
}

test("a bid resets the countdown and enforces the increment", () => {
  let draft = placeBid(liveDraft(), "a", 5);
  draft = advanceCountdown(draft);
  assert.equal(draft.auction.phase, "once");
  draft = placeBid(draft, "b", 6);
  assert.equal(draft.auction.phase, "open");
  assert.equal(draft.auction.amount, 6);
  assert.throws(() => placeBid(draft, "a", 6), /at least \$7/);
});

test("teams must reserve one dollar for every remaining roster spot", () => {
  const draft = liveDraft();
  assert.equal(maxBidForTeam(draft, "a"), 18);
  assert.throws(() => placeBid(draft, "a", 19), /at most \$18/);
});

test("going once, twice, sold updates the ledger, roster, and budget", () => {
  let draft = placeBid(liveDraft(), "a", 8);
  draft = advanceCountdown(draft);
  draft = advanceCountdown(draft);
  draft = advanceCountdown(draft);
  assert.equal(draft.auction.phase, "sold");
  assert.equal(draft.players[0].status, "sold");
  assert.equal(draft.teams[0].budget, 12);
  assert.deepEqual(draft.teams[0].roster, [{ playerId: "puka", price: 8 }]);
  assert.equal(draft.sales.length, 1);
});

test("undo restores the exact sale and nominates that player", () => {
  let draft = placeBid(liveDraft(), "a", 8);
  draft = advanceCountdown(advanceCountdown(advanceCountdown(draft)));
  draft = undoLastSale(draft);
  assert.equal(draft.players[0].status, "available");
  assert.equal(draft.teams[0].budget, 20);
  assert.deepEqual(draft.teams[0].roster, []);
  assert.equal(draft.auction.playerId, "puka");
  assert.equal(draft.auction.phase, "ready");
});

test("a player with no bids rotates to the back of the queue", () => {
  let draft = advanceCountdown(liveDraft());
  assert.equal(draft.auction.phase, "passed");
  draft = moveToNextPlayer(draft);
  assert.equal(draft.auction.playerId, "bijan");
});
