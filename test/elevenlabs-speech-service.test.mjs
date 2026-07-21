import test from "node:test";
import assert from "node:assert/strict";
import {
  ElevenLabsSpeechService,
  buildElevenLabsGeneration,
  elevenLabsVoiceSettings
} from "../src/elevenlabs-speech-service.mjs";

test("ElevenLabs generation initializes a context with energetic voice settings", () => {
  const message = buildElevenLabsGeneration({
    contextId: "lot-1",
    transcript: "Ari takes it to thirty-five!",
    style: "bid",
    personality: "hype",
    energy: 3
  });
  assert.equal(message.context_id, "lot-1");
  assert.equal(message.text, "Ari takes it to thirty-five! ");
  assert.ok(message.voice_settings.speed > elevenLabsVoiceSettings("countdown", { energy: 1 }).speed);
  assert.ok(message.voice_settings.stability < 0.4);
});

test("ElevenLabs keeps one multi-context socket warm across utterances", async () => {
  let socketCount = 0;
  let tokenRequest;
  class FakeWebSocket {
    static instance;
    constructor(url) {
      socketCount += 1;
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
  const ids = ["context-1", "context-2"];
  const service = new ElevenLabsSpeechService({
    apiKey: "secret-key",
    voiceId: "auction-voice",
    model: "eleven_flash_v2_5",
    fetchImpl: async (url, options) => {
      tokenRequest = { url, options };
      return { ok: true, json: async () => ({ token: "single-use-token" }) };
    },
    WebSocketImpl: FakeWebSocket,
    createId: () => ids.shift()
  });

  await service.warm();
  assert.equal(tokenRequest.url, "https://api.elevenlabs.io/v1/single-use-token/tts_websocket");
  assert.equal(tokenRequest.options.headers["xi-api-key"], "secret-key");
  assert.match(FakeWebSocket.instance.url, /multi-stream-input/);
  assert.match(FakeWebSocket.instance.url, /single_use_token=single-use-token/);
  assert.match(FakeWebSocket.instance.url, /output_format=pcm_24000/);
  assert.match(FakeWebSocket.instance.url, /auto_mode=true/);

  const audio = [];
  const first = await service.createSpeech({ transcript: "Going once", onEvent: (event) => audio.push(event) });
  assert.deepEqual(FakeWebSocket.instance.sent.slice(0, 3).map((message) => message.context_id), ["context-1", "context-1", "context-1"]);
  assert.equal(FakeWebSocket.instance.sent[1].flush, true);
  assert.equal(FakeWebSocket.instance.sent[2].close_context, true);
  FakeWebSocket.instance.emit("message", { data: JSON.stringify({ contextId: "context-1", audio: "AAAA", is_final: false }) });
  FakeWebSocket.instance.emit("message", { data: JSON.stringify({ contextId: "context-1", is_final: true }) });
  await first.done;
  assert.deepEqual(audio, [{ type: "audio", data: "AAAA" }]);

  const second = await service.createSpeech({ transcript: "New bid" });
  second.cancel();
  await second.done;
  assert.equal(socketCount, 1);
  assert.ok(FakeWebSocket.instance.sent.some((message) => message.context_id === "context-2" && message.close_context === true));
  service.close();
});

test("ElevenLabs is unavailable until both a key and voice ID are configured", () => {
  const missingVoice = new ElevenLabsSpeechService({ apiKey: "key", voiceId: "" });
  assert.equal(missingVoice.status().available, false);
  assert.match(missingVoice.status().message, /VOICE_ID/);
});
