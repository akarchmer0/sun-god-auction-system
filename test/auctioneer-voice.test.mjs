import test from "node:test";
import assert from "node:assert/strict";
import { AuctioneerVoice, decodePcm16 } from "../src/auctioneer-voice.mjs";

test("PCM decoder converts little-endian signed 16-bit samples", () => {
  const bytes = Buffer.from([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);
  const samples = decodePcm16(bytes.toString("base64"));
  assert.equal(samples.length, 3);
  assert.equal(samples[0], -1);
  assert.equal(samples[1], 0);
  assert.ok(samples[2] > 0.999);
});

test("a new fallback announcement interrupts the previous one", () => {
  const utterances = [];
  let cancelCount = 0;
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const speechSynthesis = {
    cancel() { cancelCount += 1; },
    getVoices() { return []; },
    speak(utterance) { utterances.push(utterance); }
  };
  const voice = new AuctioneerVoice({
    fetchImpl: async () => ({ ok: true, json: async () => ({ available: false }) }),
    AudioContextImpl: null,
    speechSynthesisImpl: speechSynthesis,
    UtteranceImpl: FakeUtterance
  });
  voice.status.available = false;
  let firstFinished = false;
  let secondFinished = false;
  voice.speak("Going once", { onDone: () => { firstFinished = true; } });
  voice.speak("Alex bids thirty-five", { onDone: () => { secondFinished = true; } });
  assert.equal(firstFinished, false);
  assert.equal(utterances.at(-1).text, "Alex bids thirty-five");
  utterances.at(-1).onend();
  assert.equal(secondFinished, true);
  assert.ok(cancelCount >= 2);
});
