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

  send(raw) {
    this.sent.push(JSON.parse(raw));
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
