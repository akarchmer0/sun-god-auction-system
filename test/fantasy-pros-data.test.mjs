import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fantasyProsPlayers } from "../src/fantasy-pros-data.mjs";

test("the FantasyPros preset contains the complete supplied list in value order", () => {
  const sourceKey = fantasyProsPlayers.map((player) => `${player.name}|${player.suggestedValue}`).join("\n");

  assert.equal(fantasyProsPlayers.length, 315);
  assert.equal(new Set(fantasyProsPlayers.map((player) => player.id)).size, 315);
  assert.equal(createHash("sha256").update(sourceKey).digest("hex"), "be2ddf83264779da380ae766401c711e53461ef675a4bbf9a3a217fbce42d5a4");
  assert.deepEqual(fantasyProsPlayers[0], {
    id: "fantasy-pros-jahmyr-gibbs-0",
    name: "Jahmyr Gibbs",
    position: "RB",
    nflTeam: "FA",
    suggestedValue: 61,
    status: "available"
  });
});

test("the FantasyPros preset supports every draft position and keeps zero-dollar values", () => {
  const positionOf = (name) => fantasyProsPlayers.find((player) => player.name === name)?.position;

  assert.equal(positionOf("Josh Allen"), "QB");
  assert.equal(positionOf("Puka Nacua"), "WR");
  assert.equal(positionOf("Brock Bowers"), "TE");
  assert.equal(positionOf("Brandon Aubrey"), "K");
  assert.equal(positionOf("Houston Texans"), "DST");
  assert.equal(fantasyProsPlayers.find((player) => player.name === "Daniel Jones")?.suggestedValue, 0);
});
