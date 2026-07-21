import {
  buildRoastInput,
  buildRoastInstructions,
  curatedRoast,
  extractResponseText,
  normalizeRoastContext,
  ROAST_REFERENCE_LINES
} from "./roast-engine.mjs";

const DEFAULT_MODEL = "gpt-5.6-luna";

export class OpenAIRoastService {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    endpoint = "https://api.openai.com/v1/responses",
    timeoutMs = 2_400,
    onError = (message) => console.warn(`[OpenAI roast] ${message}`)
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.model = String(model || DEFAULT_MODEL).trim();
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.onError = onError;
    this.lastError = null;
    this.referenceCursor = 0;
  }

  status() {
    const configured = Boolean(this.apiKey && typeof this.fetchImpl === "function");
    return {
      available: configured,
      provider: configured ? "openai" : "curated",
      model: configured ? this.model : null,
      referenceCount: ROAST_REFERENCE_LINES.length,
      message: configured
        ? this.lastError
          ? `OpenAI roast writing will retry automatically. ${this.lastError}`
          : `OpenAI ${this.model} writes contextual fantasy-football roasts.`
        : "The contextual curated roast rotation is active. Add OPENAI_API_KEY for on-the-fly riffs."
    };
  }

  async createRoast({ context, recentRoasts = [], personality = "classic" } = {}) {
    const normalized = normalizeRoastContext(context);
    const referenceIndex = this.referenceCursor;
    this.referenceCursor = (this.referenceCursor + 1) % ROAST_REFERENCE_LINES.length;
    const fallback = () => ({
      text: curatedRoast(normalized, referenceIndex),
      provider: "curated",
      model: null,
      referenceIndex
    });
    if (!this.status().available) return fallback();

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
          instructions: buildRoastInstructions({ personality, referenceIndex }),
          input: buildRoastInput(normalized, recentRoasts),
          max_output_tokens: 160,
          reasoning: { effort: "none" },
          store: false,
          text: { verbosity: "low" }
        }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.#reportError(payload?.error?.message || `OpenAI returned HTTP ${response.status}.`);
        return fallback();
      }
      const text = extractResponseText(payload);
      if (!text) {
        this.#reportError("OpenAI returned no spoken text.");
        return fallback();
      }
      this.lastError = null;
      return { text, provider: "openai", model: this.model, referenceIndex };
    } catch (error) {
      this.#reportError(error?.name === "AbortError" ? "OpenAI roast writing timed out." : error?.message || "OpenAI roast writing failed.");
      return fallback();
    } finally {
      clearTimeout(timeout);
    }
  }

  #reportError(message) {
    this.lastError = String(message || "OpenAI roast writing failed.").slice(0, 240);
    this.onError?.(this.lastError);
  }
}

export const OPENAI_ROAST_DEFAULTS = Object.freeze({ model: DEFAULT_MODEL });
