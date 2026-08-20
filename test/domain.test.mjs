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
  undoLastSale,
  correctSale,
  currentNominator,
  canTeamRosterPlayer,
  nextLegalBidAmount,
  countdownDelayMs,
  DEFAULT_COUNTDOWN_SECONDS
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

test("every nomination commits the nominating team to a one-dollar opening bid", () => {
  let draft = createDraft({ players, teams, budget: 20, rosterSize: 3, increment: 2 });
  draft = nominatePlayer(draft, "puka");
  assert.equal(draft.auction.amount, 1);
  assert.equal(draft.auction.highBidderId, "a");
  draft = openAuction(draft);
  assert.equal(nextLegalBidAmount(draft), 3);
  draft = placeBid(draft, "b");
  assert.equal(draft.auction.amount, 3);
  assert.equal(draft.auction.highBidderId, "b");
});

test("draft countdown windows are normalized and converted to timer delays", () => {
  const draft = createDraft({
    players,
    teams,
    countdownOnceSeconds: 7.3,
    countdownTwiceSeconds: 3.6
  });
  assert.equal(countdownDelayMs(draft.config, "open"), 8_000);
  assert.equal(countdownDelayMs(draft.config, "once"), 7_300);
  assert.equal(countdownDelayMs(draft.config, "twice"), 3_600);

  const defaults = createDraft({ players, teams });
  assert.equal(defaults.config.countdownOnceSeconds, DEFAULT_COUNTDOWN_SECONDS.once);
  assert.equal(defaults.config.countdownTwiceSeconds, DEFAULT_COUNTDOWN_SECONDS.twice);
});

test("a bid resets the countdown and enforces the increment", () => {
  let draft = placeBid(liveDraft(), "b", 5);
  draft = advanceCountdown(draft);
  assert.equal(draft.auction.phase, "once");
  draft = placeBid(draft, "a", 6);
  assert.equal(draft.auction.phase, "open");
  assert.equal(draft.auction.amount, 6);
  assert.throws(() => placeBid(draft, "b", 6), /at least \$7/);
});

test("teams must reserve one dollar for every remaining roster spot", () => {
  const draft = liveDraft();
  assert.equal(maxBidForTeam(draft, "a"), 18);
  assert.throws(() => placeBid(draft, "b", 19), /at most \$18/);
});

test("going once, twice, sold updates the ledger, roster, and budget", () => {
  let draft = placeBid(liveDraft(), "b", 8);
  draft = advanceCountdown(draft);
  draft = advanceCountdown(draft);
  draft = advanceCountdown(draft);
  assert.equal(draft.auction.phase, "sold");
  assert.equal(draft.players[0].status, "sold");
  assert.equal(draft.teams[1].budget, 12);
  assert.deepEqual(draft.teams[1].roster, [{ playerId: "puka", price: 8 }]);
  assert.equal(draft.sales.length, 1);
});

test("undo restores the exact sale and nominates that player", () => {
  let draft = placeBid(liveDraft(), "b", 8);
  draft = advanceCountdown(advanceCountdown(advanceCountdown(draft)));
  draft = undoLastSale(draft);
  assert.equal(draft.players[0].status, "available");
  assert.equal(draft.teams[1].budget, 20);
  assert.deepEqual(draft.teams[1].roster, []);
  assert.equal(draft.auction.playerId, "puka");
  assert.equal(draft.auction.phase, "ready");
});

test("an uncontested nomination sells to its nominator for one dollar", () => {
  let draft = advanceCountdown(advanceCountdown(advanceCountdown(liveDraft())));
  assert.equal(draft.auction.phase, "sold");
  assert.equal(draft.sales[0].teamId, "a");
  assert.equal(draft.sales[0].amount, 1);
});

test("position requirements prevent a purchase that would make the lineup impossible", () => {
  const rosteredTeams = [
    { ...teams[0], roster: [{ playerId: "puka", price: 4 }] },
    teams[1]
  ];
  let draft = createDraft({
    players,
    teams: rosteredTeams,
    budget: 20,
    rosterSize: 2,
    rosterRequirements: { QB: 1 },
    nominationOrder: ["b", "a"]
  });
  draft.teams[0].roster = [{ playerId: "puka", price: 4 }];
  draft = openAuction(nominatePlayer(draft, "bijan"));
  assert.equal(canTeamRosterPlayer(draft, "a", "bijan"), false);
  assert.throws(() => placeBid(draft, "a", 1), /position requirements/);
});

test("FLEX requirements accept an extra RB, WR, or TE after base slots", () => {
  const flexPlayers = [
    ...players,
    { id: "tight-end", name: "Tight End", position: "TE", nflTeam: "FA", suggestedValue: 1, status: "available" }
  ];
  let draft = createDraft({
    players: flexPlayers,
    teams,
    budget: 20,
    rosterSize: 3,
    rosterRequirements: { RB: 1, WR: 1, FLEX: 1 }
  });
  draft.teams[0].roster = [{ playerId: "puka", price: 4 }, { playerId: "bijan", price: 4 }];
  assert.equal(canTeamRosterPlayer(draft, "a", "tight-end"), true);
});

test("nomination order advances after a result and rewinds with undo", () => {
  let draft = createDraft({ players, teams, budget: 20, rosterSize: 3, nominationOrder: ["b", "a"] });
  assert.equal(currentNominator(draft).id, "b");
  draft = openAuction(nominatePlayer(draft, "puka"));
  assert.equal(draft.auction.nominatorTeamId, "b");
  draft = placeBid(draft, "a", 5);
  draft = advanceCountdown(advanceCountdown(advanceCountdown(draft)));
  assert.equal(currentNominator(draft).id, "a");
  draft = undoLastSale(draft);
  assert.equal(currentNominator(draft).id, "b");
  assert.equal(draft.auction.nominatorTeamId, "b");
});

test("historical sale correction deterministically rebuilds buyers, budgets, and the player pool", () => {
  let draft = placeBid(liveDraft(), "b", 5);
  draft = advanceCountdown(advanceCountdown(advanceCountdown(draft)));
  const saleId = draft.sales[0].id;
  const corrected = correctSale(draft, saleId, { teamId: "a", amount: 7 });
  assert.equal(corrected.teams.find((team) => team.id === "b").budget, 20);
  assert.equal(corrected.teams.find((team) => team.id === "a").budget, 13);
  assert.deepEqual(corrected.teams.find((team) => team.id === "a").roster, [{ playerId: "puka", price: 7 }]);
  assert.equal(corrected.auction.phase, "paused");

  const returned = correctSale(corrected, saleId, { returnToPool: true });
  assert.equal(returned.sales.length, 0);
  assert.equal(returned.players.find((player) => player.id === "puka").status, "available");
  assert.equal(returned.queue[0], "puka");
  assert.equal(returned.teams.every((team) => team.budget === 20 && team.roster.length === 0), true);
});
