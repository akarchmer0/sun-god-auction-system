import test from "node:test";
import assert from "node:assert/strict";
import relayWorker, { AuctionRoom, authorizeRelayRequest } from "../relay/worker.mjs";
import { createRoomMessage } from "../src/room-protocol.mjs";

const secret = "personal-relay-secret-that-is-long-enough";

test("personal relay room creation requires the configured admin secret", async () => {
  const env = { RELAY_ADMIN_SECRET: secret };
  assert.equal(await authorizeRelayRequest(new Request("https://relay.test/v1/rooms", { method: "POST" }), env), false);
  assert.equal(await authorizeRelayRequest(new Request("https://relay.test/v1/rooms", {
    method: "POST",
    headers: { Authorization: "Bearer wrong-secret-that-is-also-long-enough" }
  }), env), false);
  assert.equal(await authorizeRelayRequest(new Request("https://relay.test/v1/rooms", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` }
  }), env), true);
  assert.equal(await authorizeRelayRequest(new Request("https://relay.test/v1/rooms", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` }
  }), {}), false);
});

test("relay assets always revalidate so phone UI releases stay in sync", async () => {
  const response = await relayWorker.fetch(new Request("https://relay.test/bidder.css"), {
    ASSETS: { fetch: async () => new Response("body", { headers: { "Content-Type": "text/css" } }) }
  });
  assert.equal(response.headers.get("Cache-Control"), "no-cache, no-transform");
});

test("relay forwards authenticated host speech frames without persisting them", async () => {
  class FakeStorage {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.get(key); }
    async put(key, value) {
      if (typeof key === "object") for (const [name, item] of Object.entries(key)) this.values.set(name, item);
      else this.values.set(key, value);
    }
  }
  class FakeSocket {
    constructor(attachment) { this.attachment = attachment; this.sent = []; }
    deserializeAttachment() { return this.attachment; }
    serializeAttachment(value) { this.attachment = value; }
    send(value) { this.sent.push(value); }
  }
  const state = {
    storage: new FakeStorage(),
    sockets: [],
    blockConcurrencyWhile(callback) { this.ready = Promise.resolve(callback()); },
    getWebSockets(role) { return this.sockets.filter((socket) => !role || socket.attachment.role === role); }
  };
  const room = new AuctionRoom(state, {});
  await state.ready;
  const host = new FakeSocket({ role: "host", authenticated: true });
  const participant = new FakeSocket({ role: "participant", authenticated: true });
  state.sockets.push(host, participant);

  await room.webSocketMessage(host, JSON.stringify(createRoomMessage("speech.start", {
    speechId: "speech_12345", provider: "cartesia", sampleRate: 24_000, encoding: "pcm_s16le"
  })));
  assert.equal(JSON.parse(participant.sent[0]).type, "speech.start");
  assert.equal(state.storage.values.has("speech"), false);

  await room.webSocketMessage(host, JSON.stringify(createRoomMessage("speech.audio", {
    speechId: "speech_12345", data: Buffer.from([0, 0, 1, 0]).toString("base64")
  })));
  const audioMessage = JSON.parse(participant.sent[1]);
  assert.equal(audioMessage.type, "speech.audio");
  assert.deepEqual([...Buffer.from(audioMessage.data, "base64")], [0, 0, 1, 0]);

  const frame = Uint8Array.from([0, 0, 1, 0]).buffer;
  await room.webSocketMessage(host, frame);
  assert.ok(participant.sent[2] instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(participant.sent[2])], [0, 0, 1, 0]);

  await room.webSocketMessage(participant, frame);
  assert.equal(JSON.parse(participant.sent.at(-1)).type, "error");
  assert.match(JSON.parse(participant.sent.at(-1)).error, /not allowed/i);
});
