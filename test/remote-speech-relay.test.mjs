import test from "node:test";
import assert from "node:assert/strict";
import { RemoteSpeechRelay } from "../src/remote-speech-relay.mjs";

test("remote speech relay forwards the exact transcript and ignores provider audio", () => {
  const sent = [];
  const transport = {
    notify(type, payload) { sent.push({ type, ...payload }); return true; },
    notifyBinary(payload) { sent.push(new Uint8Array(payload)); return true; }
  };
  const relay = new RemoteSpeechRelay({ getTransport: () => transport });
  const pcm = Buffer.alloc(4_400, 7).toString("base64");

  relay.handle({ type: "start", speechId: "speech_12345", transcript: "Going once", performance: { style: "countdown" } });
  relay.handle({ type: "audio", speechId: "speech_12345", data: pcm });
  relay.handle({ type: "end", speechId: "speech_12345" });

  assert.equal(sent[0].type, "speech.fallback");
  assert.equal(sent[0].transcript, "Going once");
  assert.equal(sent[0].performance.style, "countdown");
  assert.equal(sent.at(-1).type, "speech.end");
  assert.equal(sent.length, 2);
});

test("remote speech cancellation discards buffered audio", () => {
  const sent = [];
  const transport = {
    notify(type, payload) { sent.push({ type, ...payload }); return true; },
    notifyBinary(payload) { sent.push(new Uint8Array(payload)); return true; }
  };
  const relay = new RemoteSpeechRelay({ getTransport: () => transport });
  relay.handle({ type: "start", speechId: "speech_12345", transcript: "Sold", performance: { style: "sold" } });
  relay.handle({ type: "audio", speechId: "speech_12345", data: Buffer.alloc(200).toString("base64") });
  relay.handle({ type: "cancel", speechId: "speech_12345" });

  assert.deepEqual(sent.map((event) => event.type), ["speech.fallback", "speech.cancel"]);
});
