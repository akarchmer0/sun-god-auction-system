import test from "node:test";
import assert from "node:assert/strict";
import {
  applyYahooMarketValues,
  evaluateMarketCalibration,
  parseYahooMarketValues
} from "../src/yahoo-market-values.mjs";

const pasted = `Fantasy
Basic
Player
Rank
Pos Rank
CER
%Drafted
Avg $
Proj $

Elite Runner
Det - RB
1




100%
73.1
64

Depth Receiver
NYG - WR
20




51%
5.2
6

Texans
Hou - DEF
146




60%
1.2
1
`;

test("Yahoo pasted rankings parse current average and projected values", () => {
  const rows = parseYahooMarketValues(pasted);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    name: "Elite Runner", nflTeam: "DET", position: "RB", rank: 1,
    draftedPercentage: 100, averageValue: 73.1, projectedValue: 64
  });
  assert.equal(rows[2].position, "DST");
});

test("Yahoo averages attach directly by name and calibrate unmatched players", () => {
  const rows = parseYahooMarketValues(pasted);
  const result = applyYahooMarketValues([
    { id: "elite", name: "Elite Runner", position: "RB", suggestedValue: 60 },
    { id: "other", name: "Other Runner", position: "RB", suggestedValue: 40 },
    { id: "houston", name: "Houston Texans", nflTeam: "FA", position: "DST", suggestedValue: 1 }
  ], rows);
  assert.equal(result.players[0].marketAverage, 73.1);
  assert.equal(result.players[0].marketSource, "yahoo-average");
  assert.equal(result.players[1].marketSource, "yahoo-curve");
  assert.ok(result.players[1].marketAverage >= 1);
  assert.equal(result.players[2].marketAverage, 1.2);
  assert.equal(result.players[2].marketSource, "yahoo-average");
  assert.ok(evaluateMarketCalibration(result.calibration, 40) > 0);
});
