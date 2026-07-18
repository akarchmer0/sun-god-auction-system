import test from "node:test";
import assert from "node:assert/strict";
import { generateArucoCardSvg } from "../src/aruco-vision.mjs";
import {
  MarkerRaiseLatch,
  VISUAL_BID_WINDOW_MS,
  classifyVisualBidBatch,
  markerIdForTeam,
  nextVisualBidAmount,
  teamForMarkerId
} from "../src/vision-bidding.mjs";

const teams = [
  { id: "a", manager: "Alex" },
  { id: "b", manager: "Blair" },
  { id: "c", manager: "Casey" }
];

test("ArUco marker IDs map to team order", () => {
  assert.equal(teamForMarkerId(teams, 0), teams[0]);
  assert.equal(teamForMarkerId(teams, 2), teams[2]);
  assert.equal(teamForMarkerId(teams, 3), null);
  assert.equal(teamForMarkerId(teams, -1), null);
  assert.equal(markerIdForTeam(teams, "b"), 1);
  assert.equal(markerIdForTeam(teams, "missing"), null);
});

test("printable cards use the same local ArUco dictionary as the scanner", () => {
  const svg = generateArucoCardSvg(0);
  assert.match(svg, /^<svg/);
  assert.match(svg, /fill="black"/);
  assert.throws(() => generateArucoCardSvg(999), /not valid/);
});

test("the visual bid amount is always the next legal increment", () => {
  assert.equal(nextVisualBidAmount({ auction: { amount: 0 }, config: { increment: 2 } }), 2);
  assert.equal(nextVisualBidAmount({ auction: { amount: 14 }, config: { increment: 2 } }), 16);
  assert.equal(VISUAL_BID_WINDOW_MS, 300);
});

test("a card must be stable before it fires and stays latched while raised", () => {
  const latch = new MarkerRaiseLatch({ stableMs: 90, releaseMs: 550 });
  assert.deepEqual(latch.update([0], 0), []);
  assert.deepEqual(latch.update([0], 100), [0]);
  assert.deepEqual(latch.update([0], 230), []);
  assert.deepEqual(latch.update([0, 0], 360), []);
});

test("a card can bid again only after it has been lowered", () => {
  const latch = new MarkerRaiseLatch({ stableMs: 90, releaseMs: 550 });
  latch.update([1], 0);
  assert.deepEqual(latch.update([1], 100), [1]);
  assert.deepEqual(latch.update([], 500), []);
  assert.deepEqual(latch.update([1], 520), []);
  assert.deepEqual(latch.update([], 1100), []);
  assert.deepEqual(latch.update([1], 1110), []);
  assert.deepEqual(latch.update([1], 1210), [1]);
});

test("multiple stable cards are emitted together for tie collection", () => {
  const latch = new MarkerRaiseLatch({ stableMs: 90, releaseMs: 550 });
  latch.update([0, 2], 0);
  assert.deepEqual(latch.update([0, 2], 100), [0, 2]);
});

test("a visual bid batch distinguishes one winner from a simultaneous tie", () => {
  assert.deepEqual(classifyVisualBidBatch([]), { kind: "none", teamIds: [] });
  assert.deepEqual(classifyVisualBidBatch(["a", "a"]), { kind: "bid", teamIds: ["a"], teamId: "a" });
  assert.deepEqual(classifyVisualBidBatch(["a", "b", "a"]), { kind: "tie", teamIds: ["a", "b"] });
});
