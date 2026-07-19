import test from "node:test";
import assert from "node:assert/strict";
import { SpeechAudioCache, countdownCacheKey } from "../src/speech-cache.mjs";

test("only compact countdown calls receive stable profile-aware cache keys", () => {
  const base = { text: "Forty dollars, going once.", style: "countdown", personality: "classic", energy: 2, voiceId: "lucy", model: "sonic" };
  assert.equal(countdownCacheKey({ ...base, style: "bid" }), null);
  assert.notEqual(countdownCacheKey(base), countdownCacheKey({ ...base, energy: 3 }));
  assert.equal(countdownCacheKey(base), countdownCacheKey({ ...base }));
});

test("speech cache is bounded and refreshes recently used countdowns", () => {
  const cache = new SpeechAudioCache({ maxEntries: 2, maxBytes: 100 });
  cache.set("once", { sampleRate: 24000, events: [{ type: "audio", data: "AAAA" }] });
  cache.set("twice", { sampleRate: 24000, events: [{ type: "audio", data: "BBBB" }] });
  assert.equal(cache.get("once").sampleRate, 24000);
  cache.set("last", { sampleRate: 24000, events: [{ type: "audio", data: "CCCC" }] });
  assert.equal(cache.get("twice"), null);
  assert.equal(cache.size, 2);
});
