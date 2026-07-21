import {
  buildPatterInput,
  buildPatterInstructions,
  parsePatterResponse,
  PATTER_RESPONSE_FORMAT
} from "./patter-director.mjs";

const DEFAULT_MODEL = "gpt-5.6-luna";

export class OpenAIPatterService {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    endpoint = "https://api.openai.com/v1/responses",
    timeoutMs = 6_000,
    onError = (message) => console.warn(`[OpenAI patter] ${message}`)
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.model = String(model || DEFAULT_MODEL).trim();
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.onError = onError;
    this.lastError = null;
  }

  status() {
    const available = Boolean(this.apiKey && typeof this.fetchImpl === "function");
    return {
      available,
      provider: available ? "openai" : "local",
      model: available ? this.model : null,
      message: available
        ? this.lastError
          ? `The AI Patter Director will retry automatically. ${this.lastError}`
          : `OpenAI ${this.model} is directing three-line live patter arcs ahead of playback.`
        : "Local live patter is active. Add OPENAI_API_KEY for the AI Patter Director."
    };
  }

  async createPatter({ context, recentLines = [], personality = "classic", energy = 2 } = {}) {
    if (!this.status().available) return { lines: [], provider: "local", model: null };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          instructions: buildPatterInstructions({ personality, energy }),
          input: buildPatterInput(context, recentLines),
          max_output_tokens: 260,
          reasoning: { effort: "none" },
          store: false,
          text: { verbosity: "low", format: PATTER_RESPONSE_FORMAT }
        }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.#reportError(payload?.error?.message || `OpenAI returned HTTP ${response.status}.`);
        return { lines: [], provider: "local", model: null };
      }
      const lines = parsePatterResponse(payload);
      if (lines.length !== 3) {
        this.#reportError("OpenAI returned an invalid patter queue.");
        return { lines: [], provider: "local", model: null };
      }
      this.lastError = null;
      return { lines, provider: "openai", model: this.model };
    } catch (error) {
      this.#reportError(error?.name === "AbortError" ? "AI patter generation timed out." : error?.message || "AI patter generation failed.");
      return { lines: [], provider: "local", model: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  #reportError(message) {
    this.lastError = String(message || "AI patter generation failed.").slice(0, 240);
    this.onError?.(this.lastError);
  }
}

export const OPENAI_PATTER_DEFAULTS = Object.freeze({ model: DEFAULT_MODEL });
