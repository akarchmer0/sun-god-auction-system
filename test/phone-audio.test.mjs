import test from "node:test";
import assert from "node:assert/strict";
import { RemotePhoneAudio, decodePcmBytes } from "../relay/public/phone-audio.mjs";

class FakeAudioContext {
  constructor() { this.state = "suspended"; this.currentTime = 0; this.destination = {}; this.sources = []; }
  async resume() { this.state = "running"; }
  createBuffer(channels, length, sampleRate) { return { duration: length / sampleRate, copyToChannel() {} }; }
  createBufferSource() {
    const source = { connect() {}, startAt: null, stopped: false, start(at) { this.startAt = at; }, stop() { this.stopped = true; }, onended: null };
    this.sources.push(source);
    return source;
  }
}

test("phone audio unlocks, schedules remote PCM, and persists mute", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  class FakeUtterance { constructor(text) { this.text = text; } }
  const player = new RemotePhoneAudio({
    AudioContextImpl: FakeAudioContext,
    speechSynthesisImpl: { cancel() {}, getVoices() { return []; }, speak() {} },
    UtteranceImpl: FakeUtterance,
    storage
  });

  assert.equal(player.state, "needs-gesture");
  assert.equal(await player.toggle(), true);
  assert.equal(player.state, "on");
  player.handleControl({ type: "speech.start", speechId: "speech_12345", sampleRate: 24_000 });
  player.handleControl({ type: "speech.audio", speechId: "speech_12345", data: Buffer.from([0, 0, 1, 0]).toString("base64") });
  assert.equal(player.audioContext.sources.length, 1);
  player.handleControl({ type: "speech.end", speechId: "speech_12345" });
  player.audioContext.sources[0].onended();
  assert.equal(player.active, null);

  assert.equal(await player.toggle(), false);
  assert.equal(player.state, "muted");
  assert.equal(values.get("sun-god-remote-audio"), "off");
});

test("PCM byte decoder handles signed little-endian samples", () => {
  const samples = decodePcmBytes(Uint8Array.from([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]));
  assert.equal(samples[0], -1);
  assert.equal(samples[1], 0);
  assert.ok(samples[2] > 0.999);
});

test("phone sound toggle confirms locally and speaks relayed transcripts", async () => {
  const spoken = [];
  class FakeUtterance { constructor(text) { this.text = text; } }
  const speechSynthesis = {
    cancel() {},
    getVoices() { return []; },
    speak(utterance) { spoken.push(utterance); }
  };
  const player = new RemotePhoneAudio({
    AudioContextImpl: FakeAudioContext,
    speechSynthesisImpl: speechSynthesis,
    UtteranceImpl: FakeUtterance,
    storage: { getItem() { return null; }, setItem() {} }
  });

  await player.toggle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(spoken[0].text, "Phone audio on.");
  player.handleControl({
    type: "speech.fallback",
    speechId: "speech_12345",
    transcript: "Going once",
    performance: { style: "countdown", personality: "classic", energy: 2, speed: "normal" }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(spoken.at(-1).text, "Going once");
});

test("browser TTS works without Web Audio and retains the active utterance", async () => {
  const spoken = [];
  class FakeUtterance { constructor(text) { this.text = text; } }
  const player = new RemotePhoneAudio({
    AudioContextImpl: null,
    speechSynthesisImpl: { cancel() {}, getVoices() { return []; }, speak(value) { spoken.push(value); } },
    UtteranceImpl: FakeUtterance,
    storage: { getItem() { return null; }, setItem() {} }
  });

  assert.equal(await player.toggle(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(player.state, "on");
  player.handleControl({ type: "speech.fallback", speechId: "speech_mobile", transcript: "Sold" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(spoken.at(-1).text, "Sold");
  assert.equal(player.active.utterance, spoken.at(-1));
  assert.match(player.statusText, /^Speaking:/);
});
