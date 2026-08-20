import test from "node:test";
import assert from "node:assert/strict";
import { simulateAutodraft, renderSimulationHtml, parseSimulationArgs, loadSimulationSource } from "../scripts/simulate-autodraft.mjs";

const players = [
  { id: "rb-one", name: "Runner One", position: "RB", nflTeam: "FA", suggestedValue: 10, status: "available" },
  { id: "wr-one", name: "Receiver One", position: "WR", nflTeam: "FA", suggestedValue: 9, status: "available" },
  { id: "rb-two", name: "Runner Two", position: "RB", nflTeam: "FA", suggestedValue: 4, status: "available" },
  { id: "wr-two", name: "Receiver Two", position: "WR", nflTeam: "FA", suggestedValue: 3, status: "available" }
];
const teams = ["a", "b"].map((id, index) => ({
  id,
  name: `Team ${id.toUpperCase()}`,
  manager: `Manager ${id.toUpperCase()}`,
  color: index ? "#5b8def" : "#f05d23",
  roster: []
}));

test("sequential simulation fills every roster and renders a standalone report", async () => {
  const simulation = await simulateAutodraft({
    players,
    teams,
    budget: 20,
    rosterSize: 2,
    rosterRequirements: { QB: 0, RB: 1, WR: 1, TE: 0, FLEX: 0, K: 0, DST: 0 },
    seed: "test-seed",
    sourceLabel: "Test pool"
  });
  assert.equal(simulation.results.sales.length, 4);
  assert.ok(simulation.state.teams.every((team) => team.roster.length === 2));
  assert.ok(simulation.lots.every((lot) => lot.outcome === "sold"));

  const html = renderSimulationHtml(simulation);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Drafted teams/);
  assert.match(html, /Runner One/);
  assert.match(html, /Sequential auction ledger/);
});

test("simulation CLI parses league and provider overrides", () => {
  const options = parseSimulationArgs([
    "--teams", "8",
    "--roster-size", "15",
    "--requirements", "QB=1,RB=2,WR=3,TE=1,FLEX=1,K=1,DST=1",
    "--mode", "local"
  ]);
  assert.equal(options.teamCount, 8);
  assert.equal(options.rosterSize, 15);
  assert.equal(options.rosterRequirements.WR, 3);
  assert.equal(options.rosterRequirements.FLEX, 1);
  assert.equal(options.mode, "local");
});

test("simulation defaults to a twelve-team league", () => {
  assert.equal(parseSimulationArgs([]).teamCount, 12);
});

test("simulation defaults to the exact FantasyPros CSV values without market overlays", async () => {
  const source = await loadSimulationSource({
    draftStatePath: "/tmp/sun-god-no-saved-draft.json",
    teamCount: 2,
    rosterSize: 2,
    seed: "fantasypros-source-test"
  });

  assert.equal(source.players.length, 315);
  assert.equal(source.players[0].name, "Jahmyr Gibbs");
  assert.equal(source.players[0].suggestedValue, 61);
  assert.equal(source.players.find((player) => player.name === "Daniel Jones")?.suggestedValue, 0);
  assert.equal(source.players.some((player) => "marketAverage" in player), false);
  assert.match(source.sourceLabel, /FantasyPros CSV snapshot/);
});
