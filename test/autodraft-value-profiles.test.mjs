import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fantasyProsPlayersFromCsv } from "../src/fantasy-pros-data.mjs";
import { AUTODRAFT_VALUE_PROFILE_SOURCES, buildAutodraftValueProfile } from "../src/autodraft-value-profiles.mjs";

const dataDirectory = new URL("../data/auto-draft-values/", import.meta.url);
const fantasyProsPlayers = fantasyProsPlayersFromCsv(await readFile(new URL("../data/player_values.csv", import.meta.url), "utf8"));

test("Alex and Yuvi profiles override the exact 340-player base universe", async () => {
  const profiles = await Promise.all(AUTODRAFT_VALUE_PROFILE_SOURCES.map(async (source) => buildAutodraftValueProfile({
    ...source,
    csvText: await readFile(new URL(source.fileName, dataDirectory), "utf8"),
    basePlayers: fantasyProsPlayers
  })));
  const baseIds = fantasyProsPlayers.map((player) => player.id).sort();
  const gibbs = fantasyProsPlayers.find((player) => player.name === "Jahmyr Gibbs");
  const stefon = fantasyProsPlayers.find((player) => player.name === "Stefon Diggs");
  const deebo = fantasyProsPlayers.find((player) => player.name === "Deebo Samuel Sr.");
  const penix = fantasyProsPlayers.find((player) => player.name === "Michael Penix Jr.");
  const alex = profiles.find((profile) => profile.manager === "Alex Gerszten");
  const yuvi = profiles.find((profile) => profile.manager === "Yuvi Bermel");

  for (const profile of profiles) {
    assert.equal(profile.basePlayerCount, 340);
    assert.deepEqual(Object.keys(profile.values).sort(), baseIds);
  }
  assert.equal(alex.values[gibbs.id], 62);
  assert.equal(yuvi.values[gibbs.id], 55);
  assert.equal(alex.values[penix.id], 5);
  assert.equal(yuvi.values[stefon.id], 10);
  assert.equal(yuvi.values[deebo.id], 6);
  assert.equal(alex.matchedCount, 305);
  assert.equal(alex.fallbackCount, 35);
  assert.equal(yuvi.matchedCount, 308);
  assert.equal(yuvi.fallbackCount, 32);
  assert.ok(!alex.excludedCustomPlayers.includes("Michael Penix Jr."));
  assert.ok(!yuvi.excludedCustomPlayers.includes("Stefon Diggs"));
  assert.ok(!yuvi.excludedCustomPlayers.includes("Deebo Samuel"));
  assert.ok(!yuvi.excludedCustomPlayers.includes("Blake Grupe"));
  assert.ok(!yuvi.excludedCustomPlayers.includes("Keenan Allen"));
  assert.deepEqual(alex.excludedCustomPlayers.slice(-4), ["Tyreek Hill", "J.J. McCarthy", "Justin Joly", "Eli Stowers"]);
});

test("a custom profile falls back to base values and excludes custom-only players", () => {
  const basePlayers = [
    { id: "alpha", name: "Alpha Player", suggestedValue: 9 },
    { id: "beta", name: "Beta Player", suggestedValue: 4 }
  ];
  const profile = buildAutodraftValueProfile({
    id: "fixture",
    manager: "Fixture Manager",
    fileName: "fixture.csv",
    csvText: "player,value\nAlpha Player,12\nCustom Only,30\n",
    basePlayers
  });

  assert.deepEqual(profile.values, { alpha: 12, beta: 4 });
  assert.equal(profile.matchedCount, 1);
  assert.equal(profile.fallbackCount, 1);
  assert.deepEqual(profile.excludedCustomPlayers, ["Custom Only"]);
});
