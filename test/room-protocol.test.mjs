import test from "node:test";
import assert from "node:assert/strict";
import { createRoomMessage, validateRoomMessage, MessageDeduplicator } from "../src/room-protocol.mjs";

test("room protocol creates versioned envelopes and rejects incompatible messages", () => {
  const message = createRoomMessage("bid.submit", { amount: 12 }, { messageId: "message_1234", roomRevision: 9 });
  assert.equal(validateRoomMessage(message).amount, 12);
  assert.throws(() => validateRoomMessage({ ...message, protocolVersion: 2 }), /unsupported protocol/);
  assert.throws(() => createRoomMessage("unknown"), /Unsupported/);
  assert.equal(validateRoomMessage(createRoomMessage("speech.start", {
    speechId: "speech_12345", sampleRate: 24_000, encoding: "pcm_s16le"
  })).sampleRate, 24_000);
  assert.throws(() => validateRoomMessage(createRoomMessage("speech.start", {
    speechId: "short", sampleRate: 24_000, encoding: "pcm_s16le"
  })), /Speech ID/);
  assert.throws(() => validateRoomMessage(createRoomMessage("speech.fallback", {
    speechId: "speech_12345", transcript: ""
  })), /transcript/);
  assert.equal(validateRoomMessage(createRoomMessage("speech.audio", {
    speechId: "speech_12345", data: Buffer.from([0, 0]).toString("base64")
  })).type, "speech.audio");
  assert.throws(() => validateRoomMessage(createRoomMessage("speech.audio", {
    speechId: "speech_12345", data: "not base64!"
  })), /Speech audio/);
});

test("message deduplication is bounded and idempotent", () => {
  const dedupe = new MessageDeduplicator(2);
  assert.equal(dedupe.accept("one"), true);
  assert.equal(dedupe.accept("one"), false);
  dedupe.accept("two");
  dedupe.accept("three");
  assert.equal(dedupe.accept("one"), true);
});
