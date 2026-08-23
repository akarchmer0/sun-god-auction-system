import test from "node:test";
import assert from "node:assert/strict";
import { createRoomMessage } from "../src/room-protocol.mjs";
import { RelayRoomTransport } from "../src/room-transports.mjs";

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(message) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  receiveBinary(bytes) {
    this.emit("message", { data: bytes });
  }

  send(raw) {
    this.sent.push(typeof raw === "string" ? JSON.parse(raw) : raw);
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

test("relay authenticates before reporting connected or publishing host state", async () => {
  FakeWebSocket.instances = [];
  const statuses = [];
  const events = [];
  const transport = new RelayRoomTransport({
    baseUrl: "https://relay.example",
    roomId: "SUN222",
    role: "host",
    credential: "host-secret",
    WebSocketImpl: FakeWebSocket,
    reconnect: false
  });

  transport.connect(
    (message) => events.push(message.type),
    ({ state }) => {
      statuses.push(state);
      if (state === "connected") transport.notify("state.publish", { room: { teams: [] } });
    }
  );

  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent.map((message) => message.type), ["host.hello"]);
  assert.deepEqual(statuses, ["connecting"]);
  await assert.rejects(
    transport.publishState({ room: { teams: [] } }),
    /still authenticating/
  );

  const hello = socket.sent[0];
  socket.receive(createRoomMessage("room.snapshot", {
    room: null,
    claims: [],
    replyTo: hello.messageId
  }, { roomRevision: 0 }));

  assert.deepEqual(events, ["room.snapshot"]);
  assert.deepEqual(statuses, ["connecting", "connected"]);
  assert.deepEqual(socket.sent.map((message) => message.type), ["host.hello", "state.publish"]);
  transport.close();
});

test("relay transports binary speech only from an authenticated host", () => {
  FakeWebSocket.instances = [];
  const received = [];
  const host = new RelayRoomTransport({
    baseUrl: "https://relay.example", roomId: "SUN222", role: "host", credential: "host-secret",
    WebSocketImpl: FakeWebSocket, reconnect: false
  });
  host.connect(() => {}, () => {});
  const socket = FakeWebSocket.instances[0];
  socket.open();
  const hello = socket.sent[0];
  socket.receive(createRoomMessage("room.snapshot", { room: null, claims: [], replyTo: hello.messageId }));
  assert.equal(host.notifyBinary(Uint8Array.from([0, 1, 2, 3])), true);
  assert.ok(socket.sent.at(-1) instanceof ArrayBuffer);

  const participant = new RelayRoomTransport({
    baseUrl: "https://relay.example", roomId: "SUN222", role: "participant", credential: "invite-secret",
    WebSocketImpl: FakeWebSocket, reconnect: false
  });
  participant.connect(() => {}, () => {}, (frame) => received.push(new Uint8Array(frame)));
  const participantSocket = FakeWebSocket.instances[1];
  participantSocket.open();
  const join = participantSocket.sent[0];
  participantSocket.receive(createRoomMessage("room.snapshot", { room: null, claims: [], replyTo: join.messageId }));
  participantSocket.receiveBinary(Uint8Array.from([4, 5]).buffer);
  assert.deepEqual([...received[0]], [4, 5]);
  assert.equal(participant.notifyBinary(Uint8Array.from([6, 7])), false);
  host.close();
  participant.close();
});

test("relay transport unwraps Blob audio frames when the browser provides them", async () => {
  FakeWebSocket.instances = [];
  const received = [];
  const transport = new RelayRoomTransport({
    baseUrl: "https://relay.example", roomId: "SUN222", role: "participant", credential: "invite-secret",
    WebSocketImpl: FakeWebSocket, reconnect: false
  });
  transport.connect(() => {}, () => {}, (frame) => received.push(new Uint8Array(frame)));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  const join = socket.sent[0];
  socket.receive(createRoomMessage("room.snapshot", { room: null, claims: [], replyTo: join.messageId }));
  transport.onBinary;
  socket.emit("message", { data: new Blob([Uint8Array.from([8, 9])]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([...received[0]], [8, 9]);
  transport.close();
});
