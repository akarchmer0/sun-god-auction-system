import { AUTO_INTENTS, AUTO_INTENT_REASONS } from "./autodraft.mjs";

export const AUTODRAFT_INTENT_RESPONSE_FORMAT = Object.freeze({
  type: "json_schema",
  name: "autodraft_team_intents",
  strict: true,
  schema: {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: {
          type: "object",
          properties: {
            teamId: { type: "string" },
            intent: { type: "string", enum: AUTO_INTENTS },
            reason: { type: "string", enum: AUTO_INTENT_REASONS }
          },
          required: ["teamId", "intent", "reason"],
          additionalProperties: false
        }
      }
    },
    required: ["decisions"],
    additionalProperties: false
  }
});

export function buildAutodraftInstructions() {
  return `You are the strategic general manager for automatic teams in a live fantasy-football salary-cap auction.

Outcome:
- Independently decide how interested each supplied auto team should be in the nominated player.
- Return one decision for every supplied team, using exactly that team's teamId.
- Use target when the team should pay a premium to pursue the player.
- Use value when the player is worth approximately the supplied suggested value to the team.
- Use discount when the team is interested only below the supplied suggested value.
- Use pass when a non-nominating team should stay silent for the entire lot, or when the nominating team should make no raise beyond its committed opening bid.
- Every nomination is a committed $1 opening bid by nomination.nominatorTeamId. That team already owns the high bid and must take the player for $1 if nobody else bids.
- The nominating team cannot avoid the $1 purchase by choosing pass. Account for that forced roster and budget outcome when deciding its intent; pass only prevents it from raising if another team bids.
- For every other team, any non-pass decision means it is willing to bid at least the next legal price and pursue the player up to its sampled maximum.

Decision criteria:
- Consider roster construction, unfilled required positions, remaining slots, remaining budget, player suggested value, positional depth still available, and the recent auction market.
- Treat suggestedValue as roster utility and marketAverage as the observed Yahoo auction market when present. Use the latter to anticipate competition, not as proof that overpaying improves the roster.
- A team that is saturated at a position should usually pass, but may choose discount for an exceptional bargain fit.
- Preserve enough flexibility and budget to complete a legal, balanced roster.
- Treat each team independently even though all decisions are returned together.

Constraints:
- Use only the supplied JSON. Do not rely on external rankings, injuries, news, ADP, depth charts, or player knowledge.
- Do not calculate or return a bid, maximum value, explanation, confidence score, or any fields outside the schema.
- The application samples the private maximum value from the intent and owns bid legality, exact prices, timing, and all state changes.
- The nominator's committed opening bid is $1. Every competing bid after it rises by the league increment.
- Return only JSON matching the requested schema.`;
}

export function buildAutodraftInput(context) {
  return JSON.stringify({ event: "autodraft_nomination_intent", ...normalizeAutodraftContext(context) });
}

export function normalizeAutodraftContext(value = {}) {
  const allowedPositions = new Set(["QB", "RB", "WR", "TE", "FLEX", "K", "DST"]);
  const cleanPosition = (position) => {
    const normalized = cleanText(position, 8).toUpperCase();
    return allowedPositions.has(normalized) ? normalized : "FLEX";
  };
  const teams = Array.isArray(value.teams) ? value.teams.slice(0, 16).map((team, index) => ({
    teamId: cleanText(team?.teamId, 80) || `team-${index + 1}`,
    teamName: cleanText(team?.teamName, 100),
    manager: cleanText(team?.manager, 100),
    strategy: "balanced",
    aggressiveness: boundedNumber(team?.aggressiveness, 0.75, 1.25, 1),
    budgetRemaining: wholeNumber(team?.budgetRemaining),
    rosterSlotsRemaining: wholeNumber(team?.rosterSlotsRemaining),
    maxLegalBid: wholeNumber(team?.maxLegalBid),
    roster: Array.isArray(team?.roster) ? team.roster.slice(0, 30).map((spot) => ({
      name: cleanText(spot?.name, 100),
      position: cleanPosition(spot?.position),
      price: wholeNumber(spot?.price)
    })) : []
  })) : [];
  const requirements = value?.league?.rosterRequirements || {};
  const remaining = value?.remainingByPosition || {};
  return {
    nomination: {
      nominatorTeamId: cleanText(value?.nomination?.nominatorTeamId, 80),
      openingBid: 1,
      committedToNominator: true
    },
    player: {
      id: cleanText(value?.player?.id, 100),
      name: cleanText(value?.player?.name, 100),
      position: cleanPosition(value?.player?.position),
      suggestedValue: wholeNumber(value?.player?.suggestedValue),
      marketAverage: wholeNumber(value?.player?.marketAverage),
      marketProjected: wholeNumber(value?.player?.marketProjected)
    },
    league: {
      budget: wholeNumber(value?.league?.budget),
      rosterSize: wholeNumber(value?.league?.rosterSize),
      rosterRequirements: Object.fromEntries([...allowedPositions].map((position) => [position, wholeNumber(requirements[position])])),
      soldCount: wholeNumber(value?.league?.soldCount),
      availableCount: wholeNumber(value?.league?.availableCount)
    },
    remainingByPosition: Object.fromEntries([...allowedPositions].filter((position) => position !== "FLEX").map((position) => [position, wholeNumber(remaining[position])])),
    recentSales: Array.isArray(value?.recentSales) ? value.recentSales.slice(-8).map((sale) => ({
      position: cleanPosition(sale?.position),
      price: wholeNumber(sale?.price),
      suggestedValue: wholeNumber(sale?.suggestedValue)
    })) : [],
    teams
  };
}

export function parseAutodraftResponse(payload, allowedTeamIds = []) {
  const outputText = typeof payload?.output_text === "string"
    ? payload.output_text
    : (payload?.output || []).flatMap((item) => item?.content || []).find((part) => part?.type === "output_text")?.text;
  if (!outputText) return [];
  try {
    const parsed = JSON.parse(outputText);
    const allowed = new Set(allowedTeamIds.map(String));
    const seen = new Set();
    const decisions = [];
    for (const decision of Array.isArray(parsed?.decisions) ? parsed.decisions : []) {
      const teamId = String(decision?.teamId || "");
      if (!allowed.has(teamId) || seen.has(teamId) || !AUTO_INTENTS.includes(decision?.intent) || !AUTO_INTENT_REASONS.includes(decision?.reason)) continue;
      seen.add(teamId);
      decisions.push({ teamId, intent: decision.intent, reason: decision.reason });
    }
    return decisions.length === allowed.size ? decisions : [];
  } catch {
    return [];
  }
}

export function normalizeFallbackDecisions(value, allowedTeamIds) {
  const allowed = new Set(allowedTeamIds.map(String));
  const supplied = new Map((Array.isArray(value) ? value : []).map((decision) => [String(decision?.teamId || ""), decision]));
  return [...allowed].map((teamId) => {
    const decision = supplied.get(teamId);
    return {
      teamId,
      intent: AUTO_INTENTS.includes(decision?.intent) ? decision.intent : "value",
      reason: AUTO_INTENT_REASONS.includes(decision?.reason) ? decision.reason : "roster_balance"
    };
  });
}

function cleanText(value, maximum) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maximum);
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100_000, Math.max(0, Math.round(number))) : 0;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
