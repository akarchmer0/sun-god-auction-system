import test from "node:test";
import assert from "node:assert/strict";
import {
  AUCTIONEER_SPEED_OPTIONS,
  auctioneerSpeedAt,
  auctioneerSpeedIndex,
  auctioneerSpeedOffset,
  normalizeAuctioneerSpeed,
  realtimePlaybackRate
} from "../src/auctioneer-speed.mjs";

test("auctioneer speed options form four stable increasing stops", () => {
  assert.deepEqual(AUCTIONEER_SPEED_OPTIONS.map((option) => option.label), ["Normal", "Fast", "Faster", "Fastest"]);
  assert.equal(auctioneerSpeedAt(3).id, "fastest");
  assert.equal(auctioneerSpeedIndex("faster"), 2);
  assert.ok(auctioneerSpeedOffset("fastest") > auctioneerSpeedOffset("fast"));
  assert.equal(normalizeAuctioneerSpeed("warp"), "normal");
});

test("realtime post-processing accelerates ElevenLabs most strongly", () => {
  assert.equal(realtimePlaybackRate("elevenlabs", "normal"), 1.08);
  assert.equal(realtimePlaybackRate("elevenlabs", "fastest"), 1.3);
  assert.ok(realtimePlaybackRate("elevenlabs", "faster") > realtimePlaybackRate("cartesia", "faster"));
  assert.equal(realtimePlaybackRate("browser", "fastest"), 1);
});
