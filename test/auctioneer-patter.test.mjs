import test from "node:test";
import assert from "node:assert/strict";
import { isLiveAuctionPhase, patterDelayMs } from "../src/auctioneer-patter.mjs";

test("patter gaps get dramatically tighter as energy rises", () => {
  assert.ok(patterDelayMs({ energy: 1 }) > patterDelayMs({ energy: 2 }));
  assert.ok(patterDelayMs({ energy: 2 }) > patterDelayMs({ energy: 3 }));
  assert.notEqual(patterDelayMs({ energy: 2, sequence: 0 }), patterDelayMs({ energy: 2, sequence: 1 }));
});

test("patter is limited to active bidding and countdown phases", () => {
  for (const phase of ["open", "once", "twice"]) assert.equal(isLiveAuctionPhase(phase), true);
  for (const phase of ["idle", "ready", "paused", "sold", "passed"]) assert.equal(isLiveAuctionPhase(phase), false);
});
