import { createRoomMessage, validateRoomMessage } from "./room-protocol.mjs";

export class LanRoomTransport {
  constructor({ roomId, fetchImpl = globalThis.fetch?.bind(globalThis), hostFetchImpl = fetchImpl, EventSourceImpl = globalThis.EventSource } = {}) {
    this.roomId = roomId;
    this.fetch = fetchImpl;
    this.hostFetch = hostFetchImpl;
    this.EventSourceImpl = EventSourceImpl;
    this.events = null;
  }

  snapshot() { return this.#request(`/api/phone-room?room=${encodeURIComponent(this.roomId)}`); }
  createRoom(body) { return this.#post("/api/phone-room/upsert", body, true); }
  claimTeam(body) { return this.#post("/api/phone-room/claim", body); }
  releaseTeam(body) { return this.#post("/api/phone-room/release", body); }
  resetClaims(body) { return this.#post("/api/phone-room/reset-claims", body, true); }
  publishState(body) { return this.#post("/api/phone-room/state", body, true); }
  submitBid(body) { return this.#post("/api/phone-room/bid", body); }

  connect(onEvent, onStatus = () => {}) {
    this.close();
    this.events = new this.EventSourceImpl(`/api/phone-room/events?room=${encodeURIComponent(this.roomId)}`);
    for (const type of ["snapshot", "room", "state", "bid"]) {
      this.events.addEventListener(type, (event) => onEvent(JSON.parse(event.data)));
    }
    this.events.onopen = () => onStatus({ state: "connected" });
    this.events.onerror = () => onStatus({ state: "reconnecting" });
    return this;
  }

  close() { this.events?.close(); this.events = null; }

  async #post(url, body, host = false) {
    return this.#request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, host);
  }

  async #request(url, options, host = false) {
    const response = await (host ? this.hostFetch : this.fetch)(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The phone bidding room is unavailable.");
    return payload;
  }
}

export class RelayRoomTransport {
  constructor({ baseUrl, roomId, role, credential, WebSocketImpl = globalThis.WebSocket, reconnect = true } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.roomId = roomId;
    this.role = role;
    this.credential = credential;
    this.WebSocketImpl = WebSocketImpl;
    this.shouldReconnect = reconnect;
    this.closed = false;
    this.socket = null;
    this.authenticated = false;
    this.handshake = null;
    this.roomRevision = 0;
    this.pending = new Map();
    this.reconnectAttempt = 0;
    this.onEvent = () => {};
    this.onStatus = () => {};
  }

  connect(onEvent, onStatus = () => {}) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.closed = false;
    this.#open();
    return this;
  }

  claimTeam(payload) { return this.request("team.claim", payload); }
  releaseTeam(payload) { return this.request("team.release", payload); }
  submitBid(payload) { return this.request("bid.submit", payload); }
  publishState(payload) { return this.request("state.publish", payload); }
  closeRoom(payload = {}) { return this.request("room.close", payload); }

  request(type, payload = {}) {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(new Error("The relay is not connected."));
    if (!this.authenticated) return Promise.reject(new Error("The relay is still authenticating."));
    const message = createRoomMessage(type, payload, { roomRevision: this.roomRevision });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(message.messageId); reject(new Error("The relay did not confirm the request.")); }, 5_000);
      this.pending.set(message.messageId, { resolve, reject, timer });
      this.socket.send(JSON.stringify(message));
    });
  }

  notify(type, payload = {}) {
    if (!this.socket || this.socket.readyState !== 1 || !this.authenticated) return false;
    this.socket.send(JSON.stringify(createRoomMessage(type, payload, { roomRevision: this.roomRevision })));
    return true;
  }

  close() {
    this.closed = true;
    this.authenticated = false;
    this.#clearHandshake();
    this.socket?.close();
    this.socket = null;
    this.#rejectPending(new Error("Relay connection closed."));
  }

  #open() {
    if (this.closed) return;
    const scheme = this.baseUrl.replace(/^http/, "ws");
    this.onStatus({ state: this.reconnectAttempt ? "reconnecting" : "connecting" });
    const socket = new this.WebSocketImpl(`${scheme}/v1/rooms/${encodeURIComponent(this.roomId)}/${this.role === "host" ? "host" : "participant"}`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      const type = this.role === "host" ? "host.hello" : "participant.join";
      const message = createRoomMessage(type, { credential: this.credential }, { roomRevision: this.roomRevision });
      const timer = setTimeout(() => {
        if (this.socket !== socket || this.authenticated) return;
        this.handshake = null;
        this.onStatus({ state: "error", error: "The relay did not authenticate this room." });
        socket.close();
      }, 5_000);
      this.handshake = { messageId: message.messageId, timer, socket };
      socket.send(JSON.stringify(message));
    });
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.authenticated = false;
      this.#clearHandshake();
      this.#rejectPending(new Error("Relay connection lost."));
      this.onStatus({ state: "disconnected" });
      if (!this.shouldReconnect || this.closed) return;
      const delay = Math.min(10_000, 500 * (2 ** Math.min(5, this.reconnectAttempt++))) + Math.floor(Math.random() * 250);
      setTimeout(() => this.#open(), delay);
    });
    socket.addEventListener("error", () => this.onStatus({ state: "reconnecting" }));
  }

  #receive(raw) {
    let message;
    try { message = validateRoomMessage(JSON.parse(raw)); }
    catch { return; }
    this.roomRevision = Math.max(this.roomRevision, Number(message.roomRevision) || 0);
    const handshakeReply = this.handshake && message.replyTo === this.handshake.messageId;
    if (handshakeReply) {
      this.#clearHandshake();
      if (message.type === "error") {
        this.onEvent(message);
        this.onStatus({ state: "error", error: message.error || "Relay authentication failed." });
        this.socket?.close();
        return;
      }
      if (message.type !== "room.snapshot") return;
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.onEvent(message);
      this.onStatus({ state: "connected" });
      return;
    }
    const replyTo = message.replyTo;
    const pending = replyTo ? this.pending.get(replyTo) : null;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(replyTo);
      if (message.type === "error") pending.reject(new Error(message.error || "Relay request failed."));
      else pending.resolve(message);
    }
    this.onEvent(message);
  }

  #clearHandshake() {
    if (this.handshake?.timer) clearTimeout(this.handshake.timer);
    this.handshake = null;
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
