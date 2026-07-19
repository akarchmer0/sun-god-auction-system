export class SpeechAudioCache {
  constructor({ maxEntries = 32, maxBytes = 8_000_000 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.totalBytes = 0;
  }

  get size() { return this.entries.size; }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (!key || !value?.events?.length) return false;
    const bytes = value.events.reduce((sum, event) => sum + base64Bytes(event.data), 0);
    if (bytes <= 0 || bytes > this.maxBytes) return false;
    const existing = this.entries.get(key);
    if (existing) { this.totalBytes -= existing.bytes; this.entries.delete(key); }
    this.entries.set(key, { value, bytes });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.totalBytes -= oldest.bytes;
    }
    return true;
  }
}

export function countdownCacheKey({ text, style, personality = "classic", energy = 2, voiceId = "", model = "" }) {
  if (style !== "countdown") return null;
  const transcript = String(text || "").trim();
  if (!transcript || transcript.length > 180) return null;
  return JSON.stringify([model, voiceId, personality, Number(energy) || 2, transcript]);
}

function base64Bytes(value) {
  const length = String(value || "").length;
  return Math.floor(length * 3 / 4);
}
