import test from "node:test";
import assert from "node:assert/strict";
import { parseSpokenBid } from "../src/bid-voice.mjs";

test("voice bid parser accepts a transcript with a collapsed bid amount", () => {
  const result = parseSpokenBid("Alex bids5");
  assert.equal(result.isBid, true);
  assert.equal(result.amount, 5);
  assert.equal(result.normalized, "alex bids 5");
});

test("voice bid parser retains ordinary bid phrases", () => {
  const result = parseSpokenBid("Alex bids 12 dollars");
  assert.equal(result.isBid, true);
  assert.equal(result.amount, 12);
});

test("voice bid parser accepts common transcription substitutions", () => {
  const bed = parseSpokenBid("bed");
  const spits = parseSpokenBid("Alex spits 5");
  assert.equal(bed.isBid, true);
  assert.equal(spits.isBid, true);
  assert.equal(spits.amount, 5);
});
