import test from "node:test";
import assert from "node:assert/strict";
import { CartesiaSpeechService, buildCartesiaGeneration, speechDirections } from "../src/cartesia-speech-service.mjs";

test("Cartesia generation uses raw PCM and expressive event direction", () => {
  const message = buildCartesiaGeneration({
    contextId: "context-1",
    transcript: "Alex takes it to thirty-five!",
    style: "bid",
    voiceId: "voice-1",
    model: "sonic-3.5",
    sampleRate: 24000
  });
  assert.equal(message.context_id, "context-1");
  assert.deepEqual(message.voice, { mode: "id", id: "voice-1" });
  assert.deepEqual(message.output_format, { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 });
  assert.equal(message.generation_config.emotion, "excited");
  assert.ok(message.generation_config.speed > speechDirections("countdown").speed);
  assert.equal(message.continue, false);
});

test("unknown speech styles fall back to neutral direction", () => {
  assert.deepEqual(speechDirections("unknown"), { speed: 1, emotion: "neutral" });
});

test("personality and energy adjust Cartesia performance direction", () => {
  const measured = speechDirections("bid", { personality: "classic", energy: 1 });
  const fullSend = speechDirections("bid", { personality: "hype", energy: 3 });
  assert.ok(fullSend.speed > measured.speed);
  assert.equal(fullSend.emotion, "excited");
});

test("roasts use a dry sarcastic performance direction", () => {
  assert.deepEqual(speechDirections("roast"), { speed: 1, emotion: "sarcastic" });
});

test("continuous patter is faster and energetic", () => {
  const patter = speechDirections("patter");
  assert.equal(patter.emotion, "enthusiastic");
  assert.ok(patter.speed > speechDirections("nomination").speed);
});

test("Cartesia service warms one socket and routes audio by context", async () => {
  class FakeWebSocket {
    static instance;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.instance = this;
      queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.emit("close", {}); }
    emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event); }
  }
  const service = new CartesiaSpeechService({
    apiKey: "test-key",
    voiceId: "voice-1",
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: "short-lived-token" }) }),
    WebSocketImpl: FakeWebSocket,
    createId: () => "context-1",
    now: () => 1_000
  });
  await service.warm();
  assert.match(FakeWebSocket.instance.url, /access_token=short-lived-token/);
  const events = [];
  const speech = await service.createSpeech({ transcript: "Going once", style: "countdown", personality: "pro", energy: 3, onEvent: (event) => events.push(event) });
  assert.equal(FakeWebSocket.instance.sent[0].context_id, "context-1");
  assert.ok(FakeWebSocket.instance.sent[0].generation_config.speed > speechDirections("countdown").speed);
  FakeWebSocket.instance.emit("message", { data: JSON.stringify({ type: "chunk", context_id: "context-1", data: "AAAA" }) });
  FakeWebSocket.instance.emit("message", { data: JSON.stringify({ type: "done", context_id: "context-1", done: true }) });
  await speech.done;
  assert.deepEqual(events, [{ type: "audio", data: "AAAA" }]);
  service.close();
});
