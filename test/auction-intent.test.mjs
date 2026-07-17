import test from "node:test";
import assert from "node:assert/strict";
import { hasPotentialBidSignal, normalizeCloudAuctionIntent } from "../src/auction-intent.mjs";

test("cloud auction intent keeps only known manager IDs and valid bid amounts", () => {
  const intent = normalizeCloudAuctionIntent({
    intent: "bid",
    amount: 12,
    manager_id: "team-alex",
    confidence: 0.92
  }, ["team-alex", "team-sam"]);

  assert.deepEqual(intent, { intent: "bid", amount: 12, managerId: "team-alex", confidence: 0.92 });
});

test("cloud auction intent fails safely for malformed or unsupported results", () => {
  assert.deepEqual(
    normalizeCloudAuctionIntent({ intent: "bid", amount: -1, manager_id: "invented", confidence: 2 }, ["team-alex"]),
    { intent: "bid", amount: null, managerId: null, confidence: 1 }
  );
  assert.deepEqual(
    normalizeCloudAuctionIntent({ intent: "other" }, ["team-alex"]),
    { intent: "ignore", amount: null, managerId: null, confidence: 0 }
  );
});

test("likely bid detection accepts noisy auction phrases and manager mentions", () => {
  assert.equal(hasPotentialBidSignal({ isBid: true, amount: null }, null), true);
  assert.equal(hasPotentialBidSignal({ isBid: false, amount: null }, { id: "team-alex" }), true);
  assert.equal(hasPotentialBidSignal({ isBid: false, amount: null }, null), false);
});
