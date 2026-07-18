import test from "node:test";
import assert from "node:assert/strict";
import { classifyPhoneBidBatch, easyBidAmounts } from "../src/phone-bidding.mjs";

test("easy bids interpolate two round amounts toward suggested value", () => {
  assert.deepEqual(easyBidAmounts({ currentBid: 1, nextBid: 2, suggestedValue: 42, maxBid: 100 }), [15, 30]);
  assert.deepEqual(easyBidAmounts({ currentBid: 37, nextBid: 38, suggestedValue: 42, maxBid: 100 }), [39, 40]);
});

test("easy bids respect the next legal bid and team maximum", () => {
  const amounts = easyBidAmounts({ currentBid: 10, nextBid: 12, suggestedValue: 55, maxBid: 20 });
  assert.equal(amounts.length, 2);
  assert.ok(amounts.every((amount) => amount >= 12 && amount <= 20));
  assert.deepEqual(easyBidAmounts({ currentBid: 60, nextBid: 61, suggestedValue: 55, maxBid: 100 }), []);
});

test("simultaneous custom bids use the highest amount and tie only at that amount", () => {
  assert.deepEqual(classifyPhoneBidBatch([
    { teamId: "a", amount: 25 },
    { teamId: "b", amount: 35 }
  ]), { kind: "bid", teamIds: ["b"], teamId: "b", amount: 35 });
  assert.deepEqual(classifyPhoneBidBatch([
    { teamId: "a", amount: 35 },
    { teamId: "b", amount: 35 },
    { teamId: "c", amount: 30 }
  ]), { kind: "tie", teamIds: ["a", "b"], amount: 35 });
});
