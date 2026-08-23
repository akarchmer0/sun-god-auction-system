export const ROOM_PROTOCOL_VERSION = 1;
export const ROOM_MESSAGE_TYPES = new Set([
  "host.hello", "participant.join", "team.claim", "team.release", "bid.submit",
  "bid.received", "bid.proposed", "bid.result", "state.publish", "host.status",
  "room.close", "room.snapshot", "error", "heartbeat", "heartbeat.ack",
  "speech.start", "speech.audio", "speech.fallback", "speech.end", "speech.cancel"
]);

export function createRoomMessage(type, payload = {}, { messageId = cryptoId(), roomRevision = 0 } = {}) {
  if (!ROOM_MESSAGE_TYPES.has(type)) throw new Error(`Unsupported room message type: ${type}`);
  return { protocolVersion: ROOM_PROTOCOL_VERSION, messageId, type, roomRevision: Math.max(0, Number(roomRevision) || 0), ...payload };
}

export function validateRoomMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Room message must be an object.");
  if (value.protocolVersion !== ROOM_PROTOCOL_VERSION) throw new Error("This bidder uses an unsupported protocol version.");
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(String(value.messageId || ""))) throw new Error("Room message ID is invalid.");
  if (!ROOM_MESSAGE_TYPES.has(value.type)) throw new Error("Room message type is invalid.");
  if (!Number.isInteger(Number(value.roomRevision)) || Number(value.roomRevision) < 0) throw new Error("Room revision is invalid.");
  if (value.type.startsWith("speech.")) validateSpeechMessage(value);
  return value;
}

function validateSpeechMessage(value) {
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(String(value.speechId || ""))) throw new Error("Speech ID is invalid.");
  if (value.type === "speech.start") {
    const sampleRate = Number(value.sampleRate);
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) throw new Error("Speech sample rate is invalid.");
    if (value.encoding !== "pcm_s16le") throw new Error("Speech encoding is invalid.");
  }
  if (value.type === "speech.audio") {
    const data = String(value.data || "");
    if (!data || data.length > 64_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Speech audio is invalid.");
  }
  if (value.type === "speech.fallback") {
    const transcript = String(value.transcript || "").trim();
    if (!transcript || transcript.length > 1_500) throw new Error("Speech transcript is invalid.");
    if (value.performance != null && (typeof value.performance !== "object" || Array.isArray(value.performance))) throw new Error("Speech performance is invalid.");
  }
}

export class MessageDeduplicator {
  constructor(limit = 2_000) {
    this.limit = limit;
    this.ids = new Set();
  }

  accept(messageId) {
    if (this.ids.has(messageId)) return false;
    this.ids.add(messageId);
    while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value);
    return true;
  }
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.().replaceAll("-", "_") || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
