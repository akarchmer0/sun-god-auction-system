import test from "node:test";
import assert from "node:assert/strict";
import { AuctioneerVoice, decodePcm16, timeCompressPcm } from "../src/auctioneer-voice.mjs";

function positiveZeroCrossings(samples) {
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1] <= 0 && samples[index] > 0) crossings += 1;
  }
  return crossings;
}

test("PCM decoder converts little-endian signed 16-bit samples", () => {
  const bytes = Buffer.from([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);
  const samples = decodePcm16(bytes.toString("base64"));
  assert.equal(samples.length, 3);
  assert.equal(samples[0], -1);
  assert.equal(samples[1], 0);
  assert.ok(samples[2] > 0.999);
});

test("audio unlock creates and resumes one reusable context from a user gesture", async () => {
  let contextsCreated = 0;
  let resumeCount = 0;
  class FakeAudioContext {
    constructor() {
      contextsCreated += 1;
      this.state = "suspended";
    }

    async resume() {
      resumeCount += 1;
      this.state = "running";
    }
  }
  const voice = new AuctioneerVoice({ AudioContextImpl: FakeAudioContext });

  assert.equal(await voice.unlock(), true);
  assert.equal(await voice.unlock(), true);
  assert.equal(contextsCreated, 1);
  assert.equal(resumeCount, 1);
});

test("a new fallback announcement interrupts the previous one by default", () => {
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

test("interrupted speech reports cancellation without pretending it completed", () => {
  const utterances = [];
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const speechSynthesis = {
    cancel() {},
    getVoices() { return []; },
    speak(utterance) { utterances.push(utterance); }
  };
  const voice = new AuctioneerVoice({
    AudioContextImpl: null,
    speechSynthesisImpl: speechSynthesis,
    UtteranceImpl: FakeUtterance
  });
  voice.status.available = false;
  let cancelled = 0;
  let completed = 0;
  voice.speak("Sold", { onCancel: () => { cancelled += 1; }, onDone: () => { completed += 1; } });
  voice.speak("Next player");
  assert.equal(cancelled, 1);
  assert.equal(completed, 0);
});

test("queued bid announcements finish the current line and collapse to the best new bid", () => {
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
    AudioContextImpl: null,
    speechSynthesisImpl: speechSynthesis,
    UtteranceImpl: FakeUtterance
  });
  voice.status.available = false;
  let firstBidFinished = false;
  let bestBidFinished = false;

  voice.speak("This room is heating up", { style: "patter" });
  const cancelsBeforeBids = cancelCount;
  voice.speak("Alex bids thirty-five", {
    style: "bid",
    priority: 100,
    interrupt: false,
    queueKey: "live-bid",
    onDone: () => { firstBidFinished = true; }
  });
  voice.speak("Jordan bids forty", {
    style: "bid",
    priority: 100,
    interrupt: false,
    queueKey: "live-bid",
    onDone: () => { bestBidFinished = true; }
  });

  assert.equal(utterances.length, 1);
  assert.equal(cancelCount, cancelsBeforeBids);
  utterances[0].onend();
  assert.equal(utterances.length, 2);
  assert.equal(utterances[1].text, "Jordan bids forty");
  assert.equal(firstBidFinished, false);
  utterances[1].onend();
  assert.equal(bestBidFinished, true);
  assert.equal(voice.isSpeaking, false);
});

test("a stalled realtime stream fails over to an energetic browser voice", async () => {
  const utterances = [];
  class FakeUtterance { constructor(text) { this.text = text; } }
  const speechSynthesis = {
    cancel() {},
    getVoices() { return [{ name: "Samantha", lang: "en-US" }]; },
    speak(utterance) { utterances.push(utterance); }
  };
  const voice = new AuctioneerVoice({
    fetchImpl: () => new Promise(() => {}),
    AudioContextImpl: class {},
    speechSynthesisImpl: speechSynthesis,
    UtteranceImpl: FakeUtterance,
    streamTimeoutMs: 5
  });
  voice.status.available = true;
  voice.speak("Can you hear Lucy?", { personality: "hype", energy: 3, speed: "fastest" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].voice.name, "Samantha");
  assert.ok(utterances[0].rate > 1.25);
  assert.equal(voice.status.provider, "browser");
});

test("stream completion watchdog releases speech when a PCM source omits onended", async () => {
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
    }
    createBuffer() {
      return { duration: 0, copyToChannel() {} };
    }
    createBufferSource() {
      return { connect() {}, start() {}, stop() {}, onended: null };
    }
  }
  const pcm = Buffer.from([0, 0]).toString("base64");
  const stream = [
    { type: "start", provider: "elevenlabs", sampleRate: 24_000 },
    { type: "audio", data: pcm },
    { type: "done" }
  ].map((event) => `${JSON.stringify(event)}\n`).join("");
  const voice = new AuctioneerVoice({
    AudioContextImpl: FakeAudioContext,
    playbackCompletionGraceMs: 5,
    fetchImpl: async () => new Response(stream, { status: 200 })
  });
  voice.status.available = true;
  let finished = false;

  voice.speak("Keep the patter moving", { onDone: () => { finished = true; } });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(finished, true);
  assert.equal(voice.isSpeaking, false);
});

test("realtime playback exposes ordered start, PCM, and end events for remote listeners", async () => {
  class FakeAudioContext {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    createBuffer() { return { duration: 0, copyToChannel() {} }; }
    createBufferSource() {
      return { connect() {}, start() { queueMicrotask(() => this.onended?.()); }, stop() {}, onended: null };
    }
  }
  const pcm = Buffer.from([0, 0, 1, 0]).toString("base64");
  const stream = [
    { type: "start", provider: "cartesia", sampleRate: 24_000 },
    { type: "audio", data: pcm },
    { type: "done" }
  ].map((event) => `${JSON.stringify(event)}\n`).join("");
  const events = [];
  const voice = new AuctioneerVoice({
    AudioContextImpl: FakeAudioContext,
    fetchImpl: async () => new Response(stream),
    onPlaybackEvent: (event) => events.push(event)
  });
  voice.status.available = true;
  voice.speak("Sold");
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(events.map((event) => event.type), ["start", "audio", "end"]);
  assert.equal(events[0].speechId, events[1].speechId);
  assert.equal(events[1].speechId, events[2].speechId);
  assert.equal(events[0].sampleRate, 24_000);
  assert.equal(events[0].transcript, "Sold");
  assert.equal(events[0].performance.style, "neutral");
});

test("ElevenLabs PCM is time-compressed without changing source playback pitch", async () => {
  const sources = [];
  const bufferLengths = [];
  class FakeAudioContext {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    createBuffer(_channels, length, sampleRate) {
      bufferLengths.push(length);
      return { duration: length / sampleRate, copyToChannel() {} };
    }
    createBufferSource() {
      const source = {
        playbackRate: { value: 1 },
        connect() {},
        start(at) { this.startAt = at; },
        stop() {},
        onended: null
      };
      sources.push(source);
      return source;
    }
  }
  const pcmSamples = new Int16Array(4_800);
  for (let index = 0; index < pcmSamples.length; index += 1) {
    pcmSamples[index] = Math.round(Math.sin(2 * Math.PI * 220 * index / 24_000) * 16_000);
  }
  const pcm = Buffer.from(pcmSamples.buffer).toString("base64");
  const stream = [
    { type: "start", provider: "elevenlabs", sampleRate: 24_000 },
    { type: "audio", data: pcm },
    { type: "done" }
  ].map((event) => `${JSON.stringify(event)}\n`).join("");
  const voice = new AuctioneerVoice({
    AudioContextImpl: FakeAudioContext,
    fetchImpl: async () => new Response(stream)
  });
  voice.status.available = true;
  voice.speak("Sold", { speed: "fastest" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sources[0].playbackRate.value, 1);
  assert.ok(bufferLengths[0] < pcmSamples.length);
  voice.cancel();
});

test("time compression shortens PCM while preserving its dominant pitch", () => {
  const sampleRate = 24_000;
  const frequency = 220;
  const input = Float32Array.from({ length: sampleRate }, (_, index) => (
    Math.sin(2 * Math.PI * frequency * index / sampleRate)
  ));
  const compressed = timeCompressPcm(input, 1.3);
  const measuredFrequency = positiveZeroCrossings(compressed) / (compressed.length / sampleRate);

  assert.ok(compressed.length < input.length * 0.85);
  assert.ok(Math.abs(measuredFrequency - frequency) < 8);
});

test("browser fallback exposes transcript lifecycle and interruption", () => {
  const utterances = [];
  class FakeUtterance { constructor(text) { this.text = text; } }
  const events = [];
  const voice = new AuctioneerVoice({
    AudioContextImpl: null,
    speechSynthesisImpl: { cancel() {}, getVoices() { return []; }, speak(value) { utterances.push(value); } },
    UtteranceImpl: FakeUtterance,
    onPlaybackEvent: (event) => events.push(event)
  });
  voice.status.available = false;
  voice.speak("Going once", { style: "countdown" });
  voice.cancel();

  assert.deepEqual(events.map((event) => event.type), ["fallback", "cancel"]);
  assert.equal(events[0].transcript, "Going once");
  assert.equal(events[0].performance.style, "countdown");
});
