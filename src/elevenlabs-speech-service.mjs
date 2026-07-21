import { randomUUID } from "node:crypto";

const DEFAULT_MODEL = "eleven_flash_v2_5";
const DEFAULT_SAMPLE_RATE = 24_000;
const TOKEN_ENDPOINT = "https://api.elevenlabs.io/v1/single-use-token/tts_websocket";

const STYLE_SETTINGS = Object.freeze({
  nomination: { stability: 0.42, similarity_boost: 0.78, speed: 1.04 },
  bid: { stability: 0.32, similarity_boost: 0.8, speed: 1.14 },
  patter: { stability: 0.3, similarity_boost: 0.78, speed: 1.12 },
  countdown: { stability: 0.5, similarity_boost: 0.82, speed: 0.94 },
  sold: { stability: 0.38, similarity_boost: 0.82, speed: 1.04 },
  roast: { stability: 0.48, similarity_boost: 0.8, speed: 1 },
  ruling: { stability: 0.55, similarity_boost: 0.82, speed: 1 },
  passed: { stability: 0.5, similarity_boost: 0.8, speed: 0.98 },
  neutral: { stability: 0.48, similarity_boost: 0.8, speed: 1 }
});

export class ElevenLabsSpeechService {
  constructor({
    apiKey,
    voiceId,
    model = DEFAULT_MODEL,
    sampleRate = DEFAULT_SAMPLE_RATE,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    createId = randomUUID
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.voiceId = String(voiceId || "").trim();
    this.model = String(model || DEFAULT_MODEL).trim();
    this.sampleRate = sampleRate;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.createId = createId;
    this.socket = null;
    this.connectPromise = null;
    this.contexts = new Map();
    this.lastError = null;
  }

  status() {
    const configured = Boolean(this.apiKey && this.voiceId);
    const supported = typeof this.fetchImpl === "function" && typeof this.WebSocketImpl === "function";
    const connected = this.socket?.readyState === 1;
    return {
      available: configured && supported,
      configured,
      connected,
      provider: "elevenlabs",
      model: this.model,
      voiceId: this.voiceId || null,
      sampleRate: this.sampleRate,
      message: !configured
        ? "Add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to .env to use an ElevenLabs auction voice."
        : !supported
          ? "ElevenLabs streaming requires Node.js 22 or newer."
          : this.lastError
            ? `ElevenLabs will reconnect automatically. ${this.lastError}`
            : connected
              ? "The ElevenLabs auctioneer stream is warm and ready."
              : "ElevenLabs is configured and will connect when the auctioneer speaks."
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
      socket.send(JSON.stringify(buildElevenLabsGeneration({ contextId, transcript: text, style, personality, energy })));
      socket.send(JSON.stringify({ context_id: contextId, flush: true }));
      // Multi-context streams emit their final event only after the context is closed.
      // Closing after flush still delivers all buffered audio and keeps the shared socket warm.
      socket.send(JSON.stringify({ context_id: contextId, close_context: true }));
    } catch (error) {
      this.contexts.delete(contextId);
      settled = true;
      throw error;
    }

    return {
      contextId,
      sampleRate: this.sampleRate,
      done,
      cancel: () => {
        if (settled) return;
        context.cancelled = true;
        if (this.socket?.readyState === 1) {
          try { this.socket.send(JSON.stringify({ context_id: contextId, close_context: true })); } catch {}
        }
        finish();
      }
    };
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (socket?.readyState === 1) {
      try { socket.send(JSON.stringify({ close_socket: true })); } catch {}
    }
    if (socket && socket.readyState < 2) socket.close(1000, "Sun God stopped");
    this.#failContexts(new Error("ElevenLabs connection closed."));
  }

  async #connect() {
    if (this.socket?.readyState === 1) return this.socket;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#openSocket();
    try { return await this.connectPromise; }
    finally { this.connectPromise = null; }
  }

  async #openSocket() {
    const token = await this.#getSingleUseToken();
    const endpoint = new URL(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/multi-stream-input`);
    endpoint.searchParams.set("single_use_token", token);
    endpoint.searchParams.set("model_id", this.model);
    endpoint.searchParams.set("output_format", `pcm_${this.sampleRate}`);
    endpoint.searchParams.set("inactivity_timeout", "180");
    endpoint.searchParams.set("auto_mode", "true");
    endpoint.searchParams.set("apply_text_normalization", "auto");
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
      socket.addEventListener("error", () => failOpening("The ElevenLabs realtime voice connection could not be opened."), { once: true });
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        if (!opened) failOpening("ElevenLabs closed the realtime voice connection before it was ready.");
        else this.#failContexts(new Error("The ElevenLabs realtime voice connection was interrupted."));
      }, { once: true });
    });
  }

  async #getSingleUseToken() {
    let response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey }
      });
    } catch {
      throw serviceError("ElevenLabs is unreachable. Check this Mac's internet connection.", 503);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.token) {
      if (response.status === 401 || response.status === 403) throw serviceError("ElevenLabs could not authenticate ELEVENLABS_API_KEY.", 503);
      if (response.status === 429) throw serviceError("ElevenLabs is rate-limiting speech generation.", 503);
      throw serviceError(payload?.detail?.message || payload?.message || "ElevenLabs could not create a realtime voice session.", 503);
    }
    return payload.token;
  }

  #handleMessage(rawMessage) {
    let event;
    try { event = JSON.parse(typeof rawMessage === "string" ? rawMessage : rawMessage.toString()); }
    catch { return; }
    const contextId = event.contextId || event.context_id;
    const context = this.contexts.get(contextId);
    if (!context || context.cancelled) return;
    if (event.audio) context.onEvent?.({ type: "audio", data: event.audio });
    if (event.error || event.message?.type === "error") {
      context.finish(serviceError(event.error || event.message?.message || "ElevenLabs could not generate that announcement.", 502));
      return;
    }
    if (event.is_final === true || event.isFinal === true) {
      context.finish();
    }
  }

  #failContexts(error) {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    for (const context of contexts) context.finish(error);
  }
}

export function elevenLabsVoiceSettings(style, { personality = "classic", energy = 2 } = {}) {
  const base = STYLE_SETTINGS[style] || STYLE_SETTINGS.neutral;
  const level = Math.min(3, Math.max(1, Number(energy) || 2));
  const personalitySpeed = personality === "hype" ? 0.05 : personality === "pro" ? 0.02 : 0;
  return {
    stability: Number(Math.max(0.2, Math.min(0.75, base.stability - (level - 2) * 0.05)).toFixed(2)),
    similarity_boost: base.similarity_boost,
    speed: Number(Math.max(0.7, Math.min(1.2, base.speed + personalitySpeed + (level - 2) * 0.06)).toFixed(2))
  };
}

export function buildElevenLabsGeneration({ contextId, transcript, style, personality = "classic", energy = 2 }) {
  return {
    context_id: contextId,
    text: `${String(transcript || "").trim()} `,
    voice_settings: elevenLabsVoiceSettings(style, { personality, energy })
  };
}

function serviceError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export const ELEVENLABS_SPEECH_DEFAULTS = Object.freeze({ model: DEFAULT_MODEL, sampleRate: DEFAULT_SAMPLE_RATE });
