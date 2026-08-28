import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseCsv } from "../src/draft-io.mjs";
import { fantasyProsPlayersFromCsv } from "../src/fantasy-pros-data.mjs";

const sourceCsv = await readFile(new URL("../data/player_values.csv", import.meta.url), "utf8");
const fantasyProsPlayers = fantasyProsPlayersFromCsv(sourceCsv);

test("the FantasyPros preset exactly follows data/player_values.csv in value order", () => {
  const sourceKey = fantasyProsPlayers.map((player) => `${player.name}|${player.suggestedValue}`).join("\n");
  const parsed = parseCsv(sourceCsv);
  const csvKey = parsed.rows.map((row) => `${row[0]}|${row[1]}`).join("\n");

  assert.equal(fantasyProsPlayers.length, 340);
  assert.equal(new Set(fantasyProsPlayers.map((player) => player.id)).size, 340);
  assert.equal(sourceKey, csvKey);
  assert.equal(createHash("sha256").update(sourceKey).digest("hex"), "388296ab7fe651affc9a61e2bbb89e483ef0dee23e236f3b32f0805737ac2583");
  assert.deepEqual(fantasyProsPlayers[0], {
    id: "fantasy-pros-jahmyr-gibbs-0",
    name: "Jahmyr Gibbs",
    position: "RB",
    nflTeam: "FA",
    suggestedValue: 63,
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
  assert.equal(positionOf("Stefon Diggs"), "WR");
  assert.equal(positionOf("Deebo Samuel Sr."), "WR");
  assert.equal(positionOf("Michael Penix Jr."), "QB");
  assert.equal(positionOf("Blake Grupe"), "K");
  assert.equal(fantasyProsPlayers.find((player) => player.name === "Daniel Jones")?.suggestedValue, 0);
});
