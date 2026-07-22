import {
  AUTODRAFT_INTENT_RESPONSE_FORMAT,
  buildAutodraftInput,
  buildAutodraftInstructions,
  normalizeAutodraftContext,
  normalizeFallbackDecisions,
  parseAutodraftResponse
} from "./autodraft-intent.mjs";

const DEFAULT_MODEL = "gpt-5.6-luna";

export class OpenAIAutodraftService {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    endpoint = "https://api.openai.com/v1/responses",
    timeoutMs = 5_000,
    onError = (message) => console.warn(`[OpenAI autodraft] ${message}`)
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
          ? `AI autodraft strategy will retry on the next nomination. ${this.lastError}`
          : `OpenAI ${this.model} decides pass, value, or target once per nomination.`
        : "Local balanced autodraft strategy is active. Add OPENAI_API_KEY for AI intent decisions."
    };
  }

  async createIntents({ context, fallbackDecisions = [] } = {}) {
    const normalized = normalizeAutodraftContext(context);
    const allowedTeamIds = normalized.teams.map((team) => team.teamId);
    const fallback = normalizeFallbackDecisions(fallbackDecisions, allowedTeamIds);
    if (!allowedTeamIds.length || !normalized.player.id) return { decisions: fallback, provider: "local", model: null };
    if (!this.status().available) return { decisions: fallback, provider: "local", model: null };

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
          instructions: buildAutodraftInstructions(),
          input: buildAutodraftInput(normalized),
          max_output_tokens: 700,
          reasoning: { effort: "none" },
          store: false,
          text: { verbosity: "low", format: AUTODRAFT_INTENT_RESPONSE_FORMAT }
        }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.#reportError(payload?.error?.message || `OpenAI returned HTTP ${response.status}.`);
        return { decisions: fallback, provider: "local", model: null };
      }
      const decisions = parseAutodraftResponse(payload, allowedTeamIds);
      if (!decisions.length) {
        this.#reportError("OpenAI returned an invalid autodraft decision set.");
        return { decisions: fallback, provider: "local", model: null };
      }
      this.lastError = null;
      return { decisions, provider: "openai", model: this.model };
    } catch (error) {
      if (error?.name === "AbortError") {
        this.lastError = `OpenAI exceeded the optional ${Math.max(1, Math.ceil(this.timeoutMs / 1_000))}-second strategy window; local decisions stayed active.`;
      } else {
        this.#reportError(error?.message || "AI autodraft strategy failed.");
      }
      return { decisions: fallback, provider: "local", model: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  #reportError(message) {
    this.lastError = String(message || "AI autodraft strategy failed.").slice(0, 240);
    this.onError?.(this.lastError);
  }
}

export const OPENAI_AUTODRAFT_DEFAULTS = Object.freeze({ model: DEFAULT_MODEL });
