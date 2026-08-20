import test from "node:test";
import assert from "node:assert/strict";
import {
  evolveAutodraftStrategy,
  parseEvolutionArgs,
  POLICY_PARAMETERS,
  policyFromVector,
  referenceMaxBid
} from "../scripts/evolve-autodraft-strategy.mjs";

const players = [
  { id: "rb-one", name: "Runner One", position: "RB", nflTeam: "FA", suggestedValue: 10, status: "available" },
  { id: "wr-one", name: "Receiver One", position: "WR", nflTeam: "FA", suggestedValue: 9, status: "available" },
  { id: "rb-two", name: "Runner Two", position: "RB", nflTeam: "FA", suggestedValue: 4, status: "available" },
  { id: "wr-two", name: "Receiver Two", position: "WR", nflTeam: "FA", suggestedValue: 3, status: "available" }
];
const teams = ["a", "b"].map((id) => ({ id, name: `Team ${id}`, manager: `Manager ${id}`, color: "#d49a1f", roster: [] }));

test("evolution produces a compact contextual policy and scores completed rosters", async () => {
  const result = await evolveAutodraftStrategy({
    players,
    teams,
    budget: 20,
    rosterSize: 2,
    increment: 1,
    rosterRequirements: { QB: 0, RB: 1, WR: 1, TE: 0, FLEX: 0, K: 0, DST: 0 },
    generations: 2,
    populationSize: 4,
    evaluations: 2,
    eliteCount: 1,
    seed: "evolution-test"
  });
  assert.equal(result.vector.length, POLICY_PARAMETERS.length);
  assert.equal(Object.keys(result.policy).length, POLICY_PARAMETERS.length);
  assert.equal(result.history.length, 2);
  assert.equal(result.seatScores.length, 2);
  assert.deepEqual(result.reward, { l2Weight: 0.5, valueScale: 50 });
  for (const seat of result.seatScores) {
    assert.equal(seat.score, seat.l1Value + 0.5 * seat.l2Value / 50);
  }
  assert.ok(result.fitness > 0);
  assert.equal(result.exampleSimulations.length, 2);
  assert.ok(result.exampleSimulations.every((simulation) => simulation.state.teams.every((team) => team.roster.length === 2)));
  assert.ok(result.exampleSimulation.state.teams.every((team) => team.roster.length === 2));
});

test("the neutral bid curve gives comparable players comparable ceilings", () => {
  const policy = policyFromVector(POLICY_PARAMETERS.map((item) => item.initial));
  const chase = referenceMaxBid(policy, { position: "WR", suggestedValue: 50 });
  const puka = referenceMaxBid(policy, { position: "WR", suggestedValue: 54 });
  assert.ok(puka > chase);
  assert.ok(puka - chase < 10);
});

test("evolution CLI parses search and reward controls", () => {
  const options = parseEvolutionArgs(["--generations", "5", "--population", "8", "--elite", "2", "--mutation-rate", "0.2", "--l2-weight", "0.75", "--value-scale", "40"]);
  assert.equal(options.generations, 5);
  assert.equal(options.populationSize, 8);
  assert.equal(options.eliteCount, 2);
  assert.equal(options.mutationRate, 0.2);
  assert.equal(options.l2Weight, 0.75);
  assert.equal(options.valueScale, 40);
});

test("evolution defaults to a twelve-team league", () => {
  assert.equal(parseEvolutionArgs([]).teamCount, 12);
});
