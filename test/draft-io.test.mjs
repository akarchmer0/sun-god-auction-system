import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv,
  suggestCsvMapping,
  playersFromMappedCsv,
  buildResultsPayload,
  resultsToCsv,
  platformResultsText,
  encodeResultsPayload,
  decodeResultsPayload
} from "../src/draft-io.mjs";

const draft = {
  config: { budget: 200, rosterSize: 2, increment: 1, rosterRequirements: { QB: 1, WR: 1 } },
  players: [
    { id: "chase", name: "Ja'Marr Chase", position: "WR", nflTeam: "CIN", suggestedValue: 56 },
    { id: "allen", name: "Josh Allen", position: "QB", nflTeam: "BUF", suggestedValue: 29 }
  ],
  teams: [
    { id: "a", name: "Alpha, Inc.", manager: "Alex", color: "#d39a20", budget: 149, roster: [{ playerId: "chase", price: 51 }] },
    { id: "b", name: "Bravo", manager: "Blair", color: "#396b49", budget: 200, roster: [] }
  ],
  sales: [{ playerId: "chase", teamId: "a", amount: 51, at: 1000 }]
};

test("CSV parser handles quoted commas, escaped quotes, and CRLF rows", () => {
  const parsed = parseCsv('Player Name,Pos,Pro Team,Auction Value\r\n"Smith, John",WR,NYJ,"$1,200"\r\n"A ""Nickname"" Jones",RB,DAL,14');
  assert.deepEqual(parsed.headers, ["Player Name", "Pos", "Pro Team", "Auction Value"]);
  assert.deepEqual(parsed.rows[0], ["Smith, John", "WR", "NYJ", "$1,200"]);
  assert.equal(parsed.rows[1][0], 'A "Nickname" Jones');
});

test("CSV column suggestions recognize common fantasy headings", () => {
  assert.deepEqual(suggestCsvMapping(["Player Name", "Pos", "Pro Team", "Auction Value"]), {
    name: 0,
    position: 1,
    team: 2,
    value: 3
  });
});

test("mapped CSV rows normalize player fields and money", () => {
  const players = playersFromMappedCsv([["Puka Nacua", "wr", "lar", "$42"]], { name: 0, position: 1, team: 2, value: 3 });
  assert.deepEqual(players[0], {
    id: "import-puka-nacua-0",
    name: "Puka Nacua",
    position: "WR",
    nflTeam: "LAR",
    suggestedValue: 42,
    status: "available"
  });
});

test("results payload powers CSV and platform copy formats", () => {
  const payload = buildResultsPayload(draft, 5000);
  assert.equal(payload.teams[0].spent, 51);
  assert.equal(payload.sales[0].fantasyTeam, "Alpha, Inc.");
  assert.match(resultsToCsv(payload), /"Alpha, Inc\."/);
  assert.match(platformResultsText(payload, "espn"), /Ja'Marr Chase\tWR\tCIN/);
  assert.match(platformResultsText(payload, "yahoo"), /Player\tNFL Team\tPosition/);
  assert.match(platformResultsText(payload, "sleeper"), /Fantasy Team\tManager\tPlayer/);
});

test("shareable result fragments round-trip a compressed draft snapshot", async () => {
  const payload = buildResultsPayload(draft, 5000);
  const encoded = await encodeResultsPayload(payload);
  assert.match(encoded, /^[gj]\./);
  assert.deepEqual(await decodeResultsPayload(encoded), payload);
});
