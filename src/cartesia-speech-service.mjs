import { randomUUID } from "node:crypto";

const DEFAULT_API_VERSION = "2026-03-01";
const DEFAULT_MODEL = "sonic-3.5";
const DEFAULT_VOICE_ID = "2f251ac3-89a9-4a77-a452-704b474ccd01"; // Lucy, Cartesia's British Capable Coordinator voice.
const DEFAULT_SAMPLE_RATE = 24_000;

const DIRECTIONS = Object.freeze({
  nomination: { speed: 1.03, emotion: "enthusiastic" },
  bid: { speed: 1.14, emotion: "excited" },
  patter: { speed: 1.12, emotion: "enthusiastic" },
  countdown: { speed: 0.94, emotion: "anticipation" },
  sold: { speed: 1.03, emotion: "triumphant" },
  roast: { speed: 1.0, emotion: "sarcastic" },
  ruling: { speed: 1.0, emotion: "determined" },
  passed: { speed: 0.98, emotion: "sarcastic" },
  neutral: { speed: 1.0, emotion: "neutral" }
});

const PERSONALITY_DIRECTIONS = Object.freeze({
  classic: { speed: 0, emotion: null },
  hype: { speed: 0.05, emotion: "excited" },
  pro: { speed: 0.03, emotion: "determined" }
});

export class CartesiaSpeechService {
  constructor({
    apiKey,
    voiceId = DEFAULT_VOICE_ID,
    model = DEFAULT_MODEL,
    apiVersion = DEFAULT_API_VERSION,
    sampleRate = DEFAULT_SAMPLE_RATE,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    createId = randomUUID,
    now = Date.now
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.voiceId = String(voiceId || DEFAULT_VOICE_ID).trim();
    this.model = String(model || DEFAULT_MODEL).trim();
    this.apiVersion = String(apiVersion || DEFAULT_API_VERSION).trim();
    this.sampleRate = sampleRate;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.createId = createId;
    this.now = now;
    this.socket = null;
    this.connectPromise = null;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.contexts = new Map();
    this.lastError = null;
  }

  status() {
    const configured = Boolean(this.apiKey);
    const supported = typeof this.fetchImpl === "function" && typeof this.WebSocketImpl === "function";
    const connected = this.socket?.readyState === 1;
    return {
      available: configured && supported,
      configured,
      connected,
      provider: "cartesia",
      model: this.model,
      voiceId: this.voiceId,
      sampleRate: this.sampleRate,
      message: !configured
        ? "Add CARTESIA_API_KEY to .env to enable the Cartesia auctioneer. Browser voice fallback is active."
        : !supported
          ? "Cartesia streaming requires Node.js 22 or newer. Browser voice fallback is active."
          : this.lastError
            ? `Cartesia will reconnect automatically. ${this.lastError}`
            : connected
              ? "Cartesia's streaming auctioneer is connected."
              : "Cartesia is configured and will connect when the auctioneer speaks."
    };
  }

  async warm() {
    if (!this.status().available) return false;
    await this.#connect();
    return true;
  }

  async createSpeech({ transcript, style = "neutral", personality = "classic", energy = 2, onEvent }) {
    const text = String(transcript || "").trim().slice(0, 1_500);
    if (!text) throw serviceError("Auctioneer speech text is required.", 400);
    if (!this.status().available) throw serviceError(this.status().message, 503);
    const socket = await this.#connect();
    const contextId = this.createId();
    let settled = false;
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      this.contexts.delete(contextId);
      if (error) rejectDone(error);
      else resolveDone();
    };
    const context = { onEvent, finish, cancelled: false };
    this.contexts.set(contextId, context);

    try {
      socket.send(JSON.stringify(buildCartesiaGeneration({
        contextId,
        transcript: text,
        style,
        personality,
        energy,
        voiceId: this.voiceId,
        model: this.model,
        sampleRate: this.sampleRate
      })));
    } catch (error) {
      settled = true;
      this.contexts.delete(contextId);
      throw error;
    }

    return {
      contextId,
      sampleRate: this.sampleRate,
      done,
      cancel: () => {
        if (settled) return;
        context.cancelled = true;
        this.contexts.delete(contextId);
        if (this.socket?.readyState === 1) {
          try { this.socket.send(JSON.stringify({ context_id: contextId, cancel: true })); } catch {}
        }
        finish();
      }
    };
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (socket && socket.readyState < 2) socket.close(1000, "Sun God stopped");
    this.#failContexts(new Error("Cartesia connection closed."));
  }

  async #connect() {
    if (this.socket?.readyState === 1) return this.socket;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#openSocket();
    try { return await this.connectPromise; }
    finally { this.connectPromise = null; }
  }

  async #openSocket() {
    const token = await this.#getAccessToken();
    const endpoint = new URL("wss://api.cartesia.ai/tts/websocket");
    endpoint.searchParams.set("access_token", token);
    endpoint.searchParams.set("cartesia_version", this.apiVersion);
    const socket = new this.WebSocketImpl(endpoint.toString());
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let opened = false;
      const failOpening = (message) => {
        if (opened) return;
        this.lastError = message;
        if (this.socket === socket) this.socket = null;
        reject(serviceError(message, 503));
      };
      socket.addEventListener("open", () => {
        opened = true;
        this.lastError = null;
        resolve(socket);
      }, { once: true });
      socket.addEventListener("message", (event) => this.#handleMessage(event.data));
      socket.addEventListener("error", () => failOpening("Cartesia's realtime voice connection could not be opened."), { once: true });
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        if (!opened) failOpening("Cartesia closed the realtime voice connection before it was ready.");
        else this.#failContexts(new Error("Cartesia's realtime voice connection was interrupted."));
      }, { once: true });
    });
  }

  async #getAccessToken() {
    if (this.accessToken && this.accessTokenExpiresAt > this.now() + 60_000) return this.accessToken;
    let response;
    try {
      response = await this.fetchImpl("https://api.cartesia.ai/access-token", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Cartesia-Version": this.apiVersion,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ grants: { tts: true }, expires_in: 3600 })
      });
    } catch {
      throw serviceError("Cartesia is unreachable. Check this Mac's internet connection.", 503);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.token) {
      if (response.status === 401 || response.status === 403) {
        throw serviceError("Cartesia could not authenticate CARTESIA_API_KEY.", 503);
      }
      if (response.status === 429) throw serviceError("Cartesia is rate-limiting speech generation. Browser voice fallback is active.", 503);
      throw serviceError(payload.message || payload.error || "Cartesia could not create a realtime voice session.", 503);
    }
    this.accessToken = payload.token;
    this.accessTokenExpiresAt = this.now() + 3_600_000;
    return this.accessToken;
  }

  #handleMessage(rawMessage) {
    let event;
    try { event = JSON.parse(typeof rawMessage === "string" ? rawMessage : rawMessage.toString()); }
    catch { return; }
    const context = this.contexts.get(event.context_id);
    if (!context || context.cancelled) return;
    if (event.type === "chunk" && event.data) {
      context.onEvent?.({ type: "audio", data: event.data });
      return;
    }
    if (event.type === "error") {
      context.finish(serviceError(event.message || event.title || "Cartesia could not generate that announcement.", 502));
      return;
    }
    if (event.type === "done" || event.done === true) context.finish();
  }

  #failContexts(error) {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    for (const context of contexts) context.finish(error);
  }
}

export function speechDirections(style, { personality = "classic", energy = 2 } = {}) {
  const base = DIRECTIONS[style] || DIRECTIONS.neutral;
  const persona = PERSONALITY_DIRECTIONS[personality] || PERSONALITY_DIRECTIONS.classic;
  const level = Math.min(3, Math.max(1, Number(energy) || 2));
  const energySpeed = (level - 2) * 0.07;
  const emotion = level === 1 && ["excited", "triumphant", "enthusiastic"].includes(base.emotion)
    ? "content"
    : persona.emotion || base.emotion;
  return { speed: Number((base.speed + persona.speed + energySpeed).toFixed(2)), emotion };
}

export function buildCartesiaGeneration({ contextId, transcript, style, personality = "classic", energy = 2, voiceId, model, sampleRate }) {
  return {
    model_id: model,
    transcript,
    voice: { mode: "id", id: voiceId },
    language: "en",
    context_id: contextId,
    output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: sampleRate },
    generation_config: speechDirections(style, { personality, energy }),
    add_timestamps: false,
    continue: false
  };
}

function serviceError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export const CARTESIA_DEFAULTS = Object.freeze({
  apiVersion: DEFAULT_API_VERSION,
  model: DEFAULT_MODEL,
  voiceId: DEFAULT_VOICE_ID,
  sampleRate: DEFAULT_SAMPLE_RATE
});
