import { canTeamRosterPlayer, maxBidForTeam, nextLegalBidAmount, ROSTER_POSITIONS } from "./domain.mjs";

export const AUTO_INTENTS = Object.freeze(["pass", "discount", "value", "target"]);
export const AUTO_INTENT_REASONS = Object.freeze([
  "required_position",
  "roster_balance",
  "value_opportunity",
  "position_saturated",
  "budget_preservation",
  "late_round_depth",
  "player_fit"
]);

const FLEX_POSITIONS = new Set(["RB", "WR", "TE"]);
const INTENT_VALUE_MULTIPLIERS = Object.freeze({
  discount: 0.9,
  value: 1,
  target: 1.1
});
const AUTO_BID_STANDARD_DEVIATION = 0.05;

export function autoTeamController(controller) {
  return controller?.type === "auto"
    ? { type: "auto", strategy: "balanced", aggressiveness: boundedNumber(controller.aggressiveness, 0.75, 1.25, 1) }
    : { type: "human", strategy: "balanced", aggressiveness: 1 };
}

export function isAutoTeam(team) {
  return autoTeamController(team?.controller).type === "auto";
}

export function localAutoIntents(state, playerId = state?.auction?.playerId) {
  return Object.fromEntries((state?.teams || []).filter(isAutoTeam).map((team) => {
    const decision = localAutoIntent(state, team.id, playerId);
    return [team.id, { ...decision, provider: "local", model: null }];
  }));
}

export function localAutoIntent(state, teamId, playerId = state?.auction?.playerId) {
  const team = state?.teams?.find((item) => item.id === teamId);
  const player = state?.players?.find((item) => item.id === playerId);
  if (!team || !player || !isAutoTeam(team) || !canTeamRosterPlayer(state, teamId, playerId)) {
    return { intent: "pass", reason: "roster_balance" };
  }

  const counts = rosterPositionCounts(state, team);
  const position = normalizePosition(player.position);
  const requirements = normalizedRequirements(state);
  const openSlots = Math.max(0, Number(state.config?.rosterSize) - team.roster.length);
  const missingAtPosition = Math.max(0, requirements[position] - (counts[position] || 0));
  const flexMissing = missingFlexSlots(requirements, counts);

  if (missingAtPosition > 0 || (FLEX_POSITIONS.has(position) && flexMissing > 0)) {
    return { intent: "target", reason: "required_position" };
  }
  if (["K", "DST"].includes(position) && openSlots > 3) {
    return { intent: "pass", reason: "late_round_depth" };
  }

  const saturationLimit = Math.max(1, requirements[position]) + (["RB", "WR"].includes(position) ? 2 : 1);
  if ((counts[position] || 0) >= saturationLimit) {
    const missingRequired = missingRequiredSlotCount(requirements, counts);
    if (!["K", "DST"].includes(position) && openSlots > missingRequired) {
      return { intent: "discount", reason: "position_saturated" };
    }
    return { intent: "pass", reason: "position_saturated" };
  }
  if (team.budget <= openSlots + Math.max(2, Math.round(playerSuggestedValue(player) * 0.3))) {
    return { intent: "discount", reason: "budget_preservation" };
  }
  return { intent: "value", reason: "value_opportunity" };
}

export function calculateAutoBidCeiling(state, teamId, playerId = state?.auction?.playerId, intent = null) {
  const team = state?.teams?.find((item) => item.id === teamId);
  const player = state?.players?.find((item) => item.id === playerId);
  if (!team || !player || !isAutoTeam(team) || !canTeamRosterPlayer(state, teamId, playerId)) return 0;

  const normalizedIntent = AUTO_INTENTS.includes(intent) ? intent : localAutoIntent(state, teamId, playerId).intent;
  if (normalizedIntent === "pass") return state.auction?.nominatorTeamId === teamId ? 1 : 0;

  const standardNormal = deterministicStandardNormal(
    `${team.id}:${player.id}:${state.auction?.nominatorTeamId || ""}:${state.sales?.length || 0}:max-value`
  );
  return Math.min(
    maxBidForTeam(state, teamId),
    sampledAutoBidValue(playerSuggestedValue(player), normalizedIntent, standardNormal)
  );
}

export function sampledAutoBidValue(suggestedValue, intent, standardNormal = 0) {
  if (intent === "pass" || !AUTO_INTENTS.includes(intent)) return 0;
  const value = wholeNumber(suggestedValue);
  const mean = value * INTENT_VALUE_MULTIPLIERS[intent];
  const noise = value * AUTO_BID_STANDARD_DEVIATION * Number(standardNormal || 0);
  return Math.max(0, Math.round(mean + noise));
}

export function chooseAutoBid(state, ceilingOverrides = null) {
  if (!["open", "once", "twice"].includes(state?.auction?.phase)) return null;
  const nextAmount = nextLegalBidAmount(state);
  const playerId = state.auction.playerId;
  const intents = state.auction.autoIntents || {};
  const candidates = state.teams.map((team) => {
    if (!isAutoTeam(team) || team.id === state.auction.highBidderId) return false;
    if (!canTeamRosterPlayer(state, team.id, playerId)) return null;
    const intent = intents[team.id]?.intent || localAutoIntent(state, team.id, playerId).intent;
    const overridden = ceilingOverrides && Object.prototype.hasOwnProperty.call(ceilingOverrides, team.id)
      ? Number(ceilingOverrides[team.id])
      : null;
    const ceiling = Number.isFinite(overridden)
      ? Math.min(maxBidForTeam(state, team.id), Math.max(team.id === state.auction.nominatorTeamId ? 1 : 0, Math.round(overridden)))
      : calculateAutoBidCeiling(state, team.id, playerId, intent);
    return nextAmount <= ceiling ? { team, intent, ceiling } : null;
  }).filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => reactionScore(state, a.team.id) - reactionScore(state, b.team.id));
  const candidate = candidates[0];
  return {
    teamId: candidate.team.id,
    amount: nextAmount,
    ceiling: candidate.ceiling,
    intent: candidate.intent
  };
}

export function chooseAutoNomination(state, teamId) {
  const team = state?.teams?.find((item) => item.id === teamId);
  if (!team || !isAutoTeam(team)) return null;
  const available = state.players.filter((player) => player.status === "available" && canTeamRosterPlayer(state, teamId, player.id));
  if (!available.length) return null;
  return available.map((player) => {
    const decision = localAutoIntent(state, teamId, player.id);
    const intentBonus = decision.intent === "target" ? 1.1 : decision.intent === "value" ? 1 : decision.intent === "discount" ? 0.9 : 0.25;
    const score = playerSuggestedValue(player) * intentBonus * deterministicMultiplier(`${teamId}:${player.id}:nominate`, 0.97, 1.03);
    return { player, score };
  }).sort((a, b) => b.score - a.score || a.player.id.localeCompare(b.player.id))[0].player.id;
}

export function buildAutoIntentContext(state) {
  const player = state.players.find((item) => item.id === state.auction.playerId);
  const available = state.players.filter((item) => item.status === "available");
  const soldPlayers = new Map(state.players.map((item) => [item.id, item]));
  const recentSales = state.sales.slice(-8).map((sale) => ({
    position: normalizePosition(soldPlayers.get(sale.playerId)?.position),
    price: wholeNumber(sale.amount),
    suggestedValue: wholeNumber(soldPlayers.get(sale.playerId)?.suggestedValue)
  }));
  return {
    nomination: {
      nominatorTeamId: String(state.auction?.nominatorTeamId || ""),
      openingBid: 1,
      committedToNominator: true
    },
    player: {
      id: player?.id || "",
      name: cleanText(player?.name, 100),
      position: normalizePosition(player?.position),
      suggestedValue: wholeNumber(player?.suggestedValue),
      marketAverage: wholeNumber(player?.marketAverage),
      marketProjected: wholeNumber(player?.marketProjected)
    },
    league: {
      budget: wholeNumber(state.config?.budget),
      rosterSize: wholeNumber(state.config?.rosterSize),
      rosterRequirements: normalizedRequirements(state),
      soldCount: state.sales.length,
      availableCount: available.length
    },
    remainingByPosition: Object.fromEntries(ROSTER_POSITIONS.filter((position) => position !== "FLEX").map((position) => [
      position,
      available.filter((item) => normalizePosition(item.position) === position).length
    ])),
    recentSales,
    teams: state.teams.filter(isAutoTeam).map((team) => ({
      teamId: team.id,
      teamName: cleanText(team.name, 100),
      manager: cleanText(team.manager, 100),
      strategy: autoTeamController(team.controller).strategy,
      aggressiveness: autoTeamController(team.controller).aggressiveness,
      budgetRemaining: wholeNumber(team.budget),
      rosterSlotsRemaining: Math.max(0, Number(state.config.rosterSize) - team.roster.length),
      maxLegalBid: maxBidForTeam(state, team.id),
      roster: team.roster.slice(0, 30).map((spot) => {
        const rosterPlayer = state.players.find((item) => item.id === spot.playerId);
        return {
          name: cleanText(rosterPlayer?.name, 100),
          position: normalizePosition(rosterPlayer?.position),
          price: wholeNumber(spot.price)
        };
      })
    }))
  };
}

export function normalizeAutoIntents(state, decisions, { provider = "local", model = null } = {}) {
  const allowedTeamIds = new Set(state.teams.filter(isAutoTeam).map((team) => team.id));
  const fallback = localAutoIntents(state);
  const normalized = { ...fallback };
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const teamId = String(decision?.teamId || "");
    if (!allowedTeamIds.has(teamId) || !AUTO_INTENTS.includes(decision?.intent) || !AUTO_INTENT_REASONS.includes(decision?.reason)) continue;
    normalized[teamId] = { intent: decision.intent, reason: decision.reason, provider, model };
  }
  return normalized;
}

export function autoBidDelayMs(state, teamId) {
  return Math.round(520 + deterministicUnit(`${state.auction.playerId}:${state.auction.bidCount}:${teamId}:delay`) * 480);
}

function rosterPositionCounts(state, team) {
  const counts = Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, 0]));
  for (const spot of team.roster || []) {
    const position = normalizePosition(state.players.find((player) => player.id === spot.playerId)?.position);
    if (position) counts[position] = (counts[position] || 0) + 1;
  }
  return counts;
}

function normalizedRequirements(state) {
  return Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Math.max(0, wholeNumber(state.config?.rosterRequirements?.[position]))]));
}

function missingFlexSlots(requirements, counts) {
  const flexEligibleSurplus = ["RB", "WR", "TE"].reduce((total, position) => {
    return total + Math.max(0, (counts[position] || 0) - (requirements[position] || 0));
  }, 0);
  return Math.max(0, (requirements.FLEX || 0) - flexEligibleSurplus);
}

function missingRequiredSlotCount(requirements, counts) {
  const baseMissing = ROSTER_POSITIONS.filter((position) => position !== "FLEX").reduce((total, position) => {
    return total + Math.max(0, (requirements[position] || 0) - (counts[position] || 0));
  }, 0);
  return baseMissing + missingFlexSlots(requirements, counts);
}

function deterministicStandardNormal(key) {
  const first = Math.max(Number.EPSILON, deterministicUnit(`${key}:u1`));
  const second = deterministicUnit(`${key}:u2`);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function reactionScore(state, teamId) {
  return deterministicUnit(`${state.auction.playerId}:${state.auction.bidCount}:${teamId}:reaction`);
}

function deterministicMultiplier(key, minimum, maximum) {
  return minimum + deterministicUnit(key) * (maximum - minimum);
}

function deterministicUnit(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function normalizePosition(value) {
  const position = String(value || "").trim().toUpperCase();
  return ROSTER_POSITIONS.includes(position) ? position : "FLEX";
}

function cleanText(value, maximum) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maximum);
}

function playerSuggestedValue(player) {
  return Math.max(1, Number(player?.suggestedValue) || 1);
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
