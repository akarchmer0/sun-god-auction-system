import { createRoomMessage, MessageDeduplicator, validateRoomMessage } from "../src/room-protocol.mjs";

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_SPEECH_FRAME_BYTES = 48_000;
const MAX_SPEECH_BYTES_PER_MINUTE = 4_000_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method === "POST" && url.pathname === "/v1/rooms") return createRoom(request, env, url.origin);
    const match = url.pathname.match(/^\/v1\/rooms\/([A-Z2-9]{6})\/(host|participant)$/);
    if (match) return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(new Request(`https://room/${match[2]}`, request));
    if (url.pathname === "/health") return json({ ok: true, protocolVersion: 1 });
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; connect-src 'self' wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    response.headers.set("Cache-Control", "no-cache, no-transform");
    return response;
  }
};

async function createRoom(request, env, origin) {
  if (!await authorizeRelayRequest(request, env)) return json({ error: "Personal relay authorization failed." }, 401);
  const roomId = randomRoomCode();
  const hostSessionSecret = randomSecret(32);
  const invitationSecret = randomSecret(16);
  const expiresAt = Date.now() + ROOM_TTL_MS;
  const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const initialized = await room.fetch("https://room/initialize", {
    method: "POST", body: JSON.stringify({ roomId, hostSessionSecret, invitationSecret, expiresAt })
  });
  if (!initialized.ok) return initialized;
  const fragment = new URLSearchParams({ room: roomId, invite: invitationSecret }).toString();
  return json({ roomId, hostSessionSecret, expiresAt, bidderUrl: `${origin}/room/${roomId}#${fragment}` }, 201);
}

export async function authorizeRelayRequest(request, env) {
  const expected = String(env?.RELAY_ADMIN_SECRET || "").trim();
  const supplied = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (expected.length < 24 || supplied.length < 24) return false;
  return await hash(supplied) === await hash(expected);
}

export class AuctionRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.meta = await state.storage.get("meta");
      this.snapshot = await state.storage.get("snapshot") || null;
      this.claims = await state.storage.get("claims") || {};
      this.revision = await state.storage.get("revision") || 0;
      this.recentIds = new MessageDeduplicator(2_000);
      for (const id of await state.storage.get("recentMessageIds") || []) this.recentIds.accept(id);
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/initialize" && request.method === "POST") {
      if (this.meta) return json({ error: "Room code collision." }, 409);
      const value = await request.json();
      this.meta = {
        roomId: value.roomId, expiresAt: value.expiresAt,
        hostHash: await hash(value.hostSessionSecret), inviteHash: await hash(value.invitationSecret)
      };
      await this.state.storage.put("meta", this.meta);
      await this.state.storage.setAlarm(value.expiresAt);
      return json({ ok: true });
    }
    if (!["/host", "/participant"].includes(path) || request.headers.get("Upgrade") !== "websocket") return new Response("Upgrade required", { status: 426 });
    if (!this.meta || this.meta.expiresAt <= Date.now()) return json({ error: "Room expired." }, 410);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [path.slice(1)]);
    server.serializeAttachment({ role: path.slice(1), authenticated: false, connectionId: crypto.randomUUID() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    let message;
    try {
      if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return this.#handleSpeechFrame(socket, raw);
      if (String(raw).length > 250_000) throw new Error("Message too large.");
      message = validateRoomMessage(JSON.parse(raw));
      if (!this.recentIds.accept(message.messageId)) return;
      if (message.type !== "speech.audio") await this.#persistRecentIds();
      await this.#handle(socket, message);
    } catch (error) {
      this.#send(socket, createRoomMessage("error", { error: error.message, replyTo: message?.messageId }, { roomRevision: this.revision }));
    }
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment() || {};
    if (attachment.role === "host" && attachment.authenticated) {
      if (attachment.speechId) this.#broadcast(createRoomMessage("speech.cancel", { speechId: attachment.speechId }, { roomRevision: this.revision }), "participant");
      this.#broadcast(createRoomMessage("host.status", { connected: false }, { roomRevision: this.revision }), "participant");
    }
  }

  async alarm() {
    for (const socket of this.state.getWebSockets()) socket.close(1001, "Room expired");
    await this.state.storage.deleteAll();
  }

  async #handle(socket, message) {
    let attachment = socket.deserializeAttachment() || {};
    if (!attachment.authenticated) return this.#authenticate(socket, attachment, message);
    const now = Date.now();
    const rateStartedAt = now - Number(attachment.rateStartedAt || 0) >= 60_000 ? now : Number(attachment.rateStartedAt || now);
    const rateCount = message.type === "speech.audio"
      ? Number(attachment.rateCount || 0)
      : rateStartedAt === now ? 1 : Number(attachment.rateCount || 0) + 1;
    if (rateCount > 240) throw new Error("Too many relay messages. Wait a moment and try again.");
    attachment = { ...attachment, rateStartedAt, rateCount };
    socket.serializeAttachment(attachment);
    if (message.type === "heartbeat") return this.#send(socket, createRoomMessage("heartbeat.ack", { replyTo: message.messageId }, { roomRevision: this.revision }));
    if (message.type === "room.close" && attachment.role === "host") {
      this.#broadcast(createRoomMessage("room.close", { replyTo: message.messageId }, { roomRevision: this.revision }));
      return this.alarm();
    }
    if (attachment.role === "host") return this.#handleHost(socket, message);
    return this.#handleParticipant(socket, attachment, message);
  }

  async #authenticate(socket, attachment, message) {
    const expectedType = attachment.role === "host" ? "host.hello" : "participant.join";
    const expectedHash = attachment.role === "host" ? this.meta.hostHash : this.meta.inviteHash;
    if (message.type !== expectedType || await hash(message.credential) !== expectedHash) throw new Error("Room credential is invalid.");
    if (attachment.role === "host" && this.#hostConnected()) throw new Error("A commissioner is already connected.");
    if (attachment.role === "participant" && this.#participantCount() >= 16) throw new Error("This room has reached 16 phone connections.");
    socket.serializeAttachment({ ...attachment, authenticated: true, participantTokenHash: null });
    this.#send(socket, createRoomMessage("room.snapshot", { room: this.snapshot, claims: publicClaims(this.claims), hostConnected: this.#hostConnected(), replyTo: message.messageId }, { roomRevision: this.revision }));
    if (attachment.role === "host") this.#broadcast(createRoomMessage("host.status", { connected: true }, { roomRevision: this.revision }), "participant");
  }

  async #handleHost(socket, message) {
    if (message.type === "state.publish") {
      if (Number(message.roomRevision) < this.revision) return this.#send(socket, createRoomMessage("error", { error: "Stale room revision.", replyTo: message.messageId }, { roomRevision: this.revision }));
      this.snapshot = normalizeSnapshot(message.room);
      this.revision += 1;
      await this.state.storage.put({ snapshot: this.snapshot, revision: this.revision });
      return this.#broadcast(createRoomMessage("room.snapshot", { room: this.snapshot, claims: publicClaims(this.claims), hostConnected: true, replyTo: message.messageId }, { roomRevision: this.revision }));
    }
    if (message.type === "bid.result") {
      const result = createRoomMessage("bid.result", { ...message, replyTo: message.participantMessageId }, { messageId: message.messageId, roomRevision: this.revision });
      return this.#broadcastToTeam(message.teamId, result);
    }
    if (message.type === "speech.start" || message.type === "speech.fallback") {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.speechId && attachment.speechId !== message.speechId) {
        this.#broadcast(createRoomMessage("speech.cancel", { speechId: attachment.speechId }, { roomRevision: this.revision }), "participant");
      }
      socket.serializeAttachment({ ...attachment, speechId: message.speechId });
      const payload = message.type === "speech.start"
        ? { speechId: message.speechId, provider: cleanSpeechProvider(message.provider), sampleRate: Number(message.sampleRate), encoding: "pcm_s16le" }
        : { speechId: message.speechId, transcript: String(message.transcript).trim(), performance: cleanSpeechPerformance(message.performance) };
      return this.#broadcast(createRoomMessage(message.type, payload, { messageId: message.messageId, roomRevision: this.revision }), "participant");
    }
    if (message.type === "speech.audio") {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.speechId !== message.speechId) throw new Error("Speech stream is no longer active.");
      const byteLength = base64ByteLength(message.data);
      if (!byteLength || byteLength > MAX_SPEECH_FRAME_BYTES || byteLength % 2 !== 0) throw new Error("Speech audio frame is invalid.");
      this.#recordSpeechBytes(socket, attachment, byteLength);
      return this.#broadcast(createRoomMessage("speech.audio", {
        speechId: message.speechId,
        data: message.data
      }, { messageId: message.messageId, roomRevision: this.revision }), "participant");
    }
    if (message.type === "speech.end" || message.type === "speech.cancel") {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.speechId !== message.speechId) throw new Error("Speech stream is no longer active.");
      socket.serializeAttachment({ ...attachment, speechId: null });
      return this.#broadcast(createRoomMessage(message.type, { speechId: message.speechId }, { messageId: message.messageId, roomRevision: this.revision }), "participant");
    }
    throw new Error("Host message is not allowed.");
  }

  #handleSpeechFrame(socket, raw) {
    const attachment = socket.deserializeAttachment() || {};
    if (!attachment.authenticated || attachment.role !== "host" || !attachment.speechId) throw new Error("Speech audio is not allowed.");
    const bytes = raw instanceof ArrayBuffer
      ? raw
      : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    if (!bytes.byteLength || bytes.byteLength > MAX_SPEECH_FRAME_BYTES || bytes.byteLength % 2 !== 0) throw new Error("Speech audio frame is invalid.");
    this.#recordSpeechBytes(socket, attachment, bytes.byteLength);
    this.#broadcastBinary(bytes, "participant");
  }

  #recordSpeechBytes(socket, attachment, byteLength) {
    const now = Date.now();
    const speechRateStartedAt = now - Number(attachment.speechRateStartedAt || 0) >= 60_000 ? now : Number(attachment.speechRateStartedAt || now);
    const speechBytes = speechRateStartedAt === now ? byteLength : Number(attachment.speechBytes || 0) + byteLength;
    if (speechBytes > MAX_SPEECH_BYTES_PER_MINUTE) throw new Error("Speech audio rate limit exceeded.");
    socket.serializeAttachment({ ...attachment, speechRateStartedAt, speechBytes });
  }

  async #handleParticipant(socket, attachment, message) {
    if (message.type === "team.claim") {
      const teamId = cleanId(message.teamId);
      if (!this.snapshot?.teams?.some((team) => team.id === teamId && !team.autoDraft)) throw new Error("Choose a valid team.");
      const tokenHash = await hash(message.participantToken);
      const existing = this.claims[teamId];
      if (existing && existing !== tokenHash) throw new Error("That team is already claimed.");
      for (const [claimedTeamId, claimHash] of Object.entries(this.claims)) if (claimHash === tokenHash && claimedTeamId !== teamId) delete this.claims[claimedTeamId];
      this.claims[teamId] = tokenHash;
      socket.serializeAttachment({ ...attachment, participantTokenHash: tokenHash, teamId });
      await this.state.storage.put("claims", this.claims);
      return this.#broadcast(createRoomMessage("room.snapshot", { room: this.snapshot, claims: publicClaims(this.claims), hostConnected: this.#hostConnected(), replyTo: message.messageId }, { roomRevision: this.revision }));
    }
    if (message.type === "team.release") {
      if (attachment.teamId && this.claims[attachment.teamId] === attachment.participantTokenHash) delete this.claims[attachment.teamId];
      socket.serializeAttachment({ ...attachment, participantTokenHash: null, teamId: null });
      await this.state.storage.put("claims", this.claims);
      return this.#broadcast(createRoomMessage("room.snapshot", { room: this.snapshot, claims: publicClaims(this.claims), hostConnected: this.#hostConnected(), replyTo: message.messageId }, { roomRevision: this.revision }));
    }
    if (message.type === "bid.submit") {
      if (!this.#hostConnected()) throw new Error("The commissioner is offline; bids are paused.");
      if (!attachment.teamId || this.claims[attachment.teamId] !== attachment.participantTokenHash) throw new Error("Claim a team before bidding.");
      if (!this.snapshot?.auction?.acceptingBids) throw new Error("Bidding is not open.");
      const amount = Number(message.amount);
      if (!Number.isInteger(amount) || amount < Number(this.snapshot.auction.nextBid)) throw new Error("Bid amount is not legal.");
      const team = this.snapshot.teams.find((item) => item.id === attachment.teamId);
      if (!team || amount > Number(team.maxBid)) throw new Error("Bid exceeds the team maximum.");
      const receivedAt = Date.now();
      if (receivedAt - Number(attachment.lastBidAt || 0) < 200) throw new Error("Bid already received.");
      socket.serializeAttachment({ ...attachment, lastBidAt: receivedAt });
      this.#send(socket, createRoomMessage("bid.received", { amount, receivedAt, replyTo: message.messageId }, { roomRevision: this.revision }));
      return this.#broadcast(createRoomMessage("bid.proposed", { teamId: attachment.teamId, amount, receivedAt, participantMessageId: message.messageId }, { roomRevision: this.revision }), "host");
    }
    throw new Error("Participant message is not allowed.");
  }

  #hostConnected() { return this.state.getWebSockets("host").some((socket) => socket.deserializeAttachment()?.authenticated); }
  #participantCount() { return this.state.getWebSockets("participant").filter((socket) => socket.deserializeAttachment()?.authenticated).length; }
  #send(socket, message) { try { socket.send(JSON.stringify(message)); } catch {} }
  #broadcast(message, role = null) { for (const socket of this.state.getWebSockets(role || undefined)) if (socket.deserializeAttachment()?.authenticated) this.#send(socket, message); }
  #broadcastBinary(bytes, role = null) { for (const socket of this.state.getWebSockets(role || undefined)) if (socket.deserializeAttachment()?.authenticated) { try { socket.send(bytes); } catch {} } }
  #broadcastToTeam(teamId, message) { for (const socket of this.state.getWebSockets("participant")) if (socket.deserializeAttachment()?.authenticated && socket.deserializeAttachment()?.teamId === teamId) this.#send(socket, message); }
  async #persistRecentIds() { await this.state.storage.put("recentMessageIds", [...this.recentIds.ids]); }
}

function normalizeSnapshot(room) {
  const encoded = JSON.stringify(room);
  if (encoded.length > 200_000 || !Array.isArray(room?.teams) || room.teams.length > 16) throw new Error("Public room snapshot is invalid.");
  const meetingLink = String(room.meetingLink || "").trim();
  return { ...room, meetingLink: /^https:\/\//i.test(meetingLink) ? meetingLink.slice(0, 500) : "" };
}
function publicClaims(claims) { return Object.keys(claims); }
function cleanSpeechProvider(value) { const provider = String(value || "realtime").trim().toLowerCase(); return /^[a-z0-9_-]{1,30}$/.test(provider) ? provider : "realtime"; }
function base64ByteLength(value) {
  const data = String(value || "");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}
function cleanSpeechPerformance(value) {
  const performance = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    style: String(performance.style || "neutral").trim().slice(0, 30),
    personality: ["classic", "hype", "pro"].includes(performance.personality) ? performance.personality : "classic",
    energy: Math.min(3, Math.max(1, Number(performance.energy) || 2)),
    speed: ["measured", "normal", "fast", "fastest"].includes(performance.speed) ? performance.speed : "normal"
  };
}
function cleanId(value) { const id = String(value || ""); if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Team ID is invalid."); return id; }
async function hash(value) { return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || ""))))); }
function randomSecret(bytes) { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return bytesToBase64Url(value); }
function randomRoomCode() { const value = new Uint8Array(6); crypto.getRandomValues(value); return [...value].map((byte) => ROOM_CHARS[byte % ROOM_CHARS.length]).join(""); }
function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function cors(response) { response.headers.set("Access-Control-Allow-Origin", "*"); response.headers.set("Access-Control-Allow-Headers", "authorization, content-type"); response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); return response; }
function json(value, status = 200) { return cors(new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })); }
