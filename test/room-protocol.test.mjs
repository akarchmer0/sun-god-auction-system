import test from "node:test";
import assert from "node:assert/strict";
import { createRoomMessage, validateRoomMessage, MessageDeduplicator } from "../src/room-protocol.mjs";

test("room protocol creates versioned envelopes and rejects incompatible messages", () => {
  const message = createRoomMessage("bid.submit", { amount: 12 }, { messageId: "message_1234", roomRevision: 9 });
  assert.equal(validateRoomMessage(message).amount, 12);
  assert.throws(() => validateRoomMessage({ ...message, protocolVersion: 2 }), /unsupported protocol/);
  assert.throws(() => createRoomMessage("unknown"), /Unsupported/);
});

test("message deduplication is bounded and idempotent", () => {
  const dedupe = new MessageDeduplicator(2);
  assert.equal(dedupe.accept("one"), true);
  assert.equal(dedupe.accept("one"), false);
  dedupe.accept("two");
  dedupe.accept("three");
  assert.equal(dedupe.accept("one"), true);
});
