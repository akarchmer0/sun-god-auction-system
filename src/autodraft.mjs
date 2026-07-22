import { canTeamRosterPlayer, maxBidForTeam, ROSTER_POSITIONS } from "./domain.mjs";

export const AUTO_INTENTS = Object.freeze(["pass", "value", "target"]);
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
const VALUE_DISCOUNT = 0.65;

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
    return { intent: "pass", reason: "position_saturated" };
  }
  if (team.budget <= openSlots + Math.max(2, Math.round(Number(player.suggestedValue) * 0.3))) {
    return { intent: "value", reason: "budget_preservation" };
  }
  return { intent: "value", reason: "value_opportunity" };
}

export function calculateAutoBidCeiling(state, teamId, playerId = state?.auction?.playerId, intent = null) {
  const team = state?.teams?.find((item) => item.id === teamId);
  const player = state?.players?.find((item) => item.id === playerId);
  if (!team || !player || !isAutoTeam(team) || !canTeamRosterPlayer(state, teamId, playerId)) return 0;

  const normalizedIntent = AUTO_INTENTS.includes(intent) ? intent : localAutoIntent(state, teamId, playerId).intent;
  if (normalizedIntent === "pass") return 0;

  const counts = rosterPositionCounts(state, team);
  const position = normalizePosition(player.position);
  const requirements = normalizedRequirements(state);
  const positionNeed = Math.max(0, requirements[position] - (counts[position] || 0));
  const flexNeed = FLEX_POSITIONS.has(position) ? missingFlexSlots(requirements, counts) : 0;
  const needMultiplier = positionNeed > 0 || flexNeed > 0 ? 1.12 : repeatedPositionMultiplier(position, counts[position] || 0, requirements[position] || 0);
  const marketMultiplier = recentMarketMultiplier(state);
  const aggressiveness = autoTeamController(team.controller).aggressiveness;
  const variation = deterministicMultiplier(`${team.id}:${player.id}`, 0.94, 1.06);
  const suggestedValue = Math.max(1, wholeNumber(player.suggestedValue));
  const intentMultiplier = normalizedIntent === "value" ? VALUE_DISCOUNT : 1;
  const strategicValue = Math.max(1, Math.round(suggestedValue * needMultiplier * marketMultiplier * aggressiveness * variation * intentMultiplier));
  return Math.min(maxBidForTeam(state, teamId), strategicValue);
}

export function chooseAutoBid(state) {
  if (!["open", "once", "twice"].includes(state?.auction?.phase)) return null;
  const nextAmount = Math.max(1, Number(state.auction.amount || 0) + Number(state.config?.increment || 1));
  const playerId = state.auction.playerId;
  const intents = state.auction.autoIntents || {};
  const candidates = state.teams.map((team) => {
    if (!isAutoTeam(team) || team.id === state.auction.highBidderId) return false;
    const intent = intents[team.id]?.intent || localAutoIntent(state, team.id, playerId).intent;
    const ceiling = calculateAutoBidCeiling(state, team.id, playerId, intent);
    return nextAmount <= ceiling ? { team, intent, ceiling } : null;
  }).filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => reactionScore(state, a.team.id) - reactionScore(state, b.team.id));
  const candidate = candidates[0];
  const highBidder = state.teams.find((team) => team.id === state.auction.highBidderId);
  let amount = nextAmount;
  if (isAutoTeam(highBidder)) {
    const leaderIntent = intents[highBidder.id]?.intent || localAutoIntent(state, highBidder.id, playerId).intent;
    const leaderCeiling = calculateAutoBidCeiling(state, highBidder.id, playerId, leaderIntent);
    amount = candidate.ceiling > leaderCeiling
      ? Math.min(candidate.ceiling, Math.max(nextAmount, leaderCeiling + Number(state.config.increment || 1)))
      : candidate.ceiling;
  }
  return {
    teamId: candidate.team.id,
    amount,
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
    const intentBonus = decision.intent === "target" ? 1.2 : decision.intent === "value" ? 0.8 : 0.25;
    const score = Math.max(1, Number(player.suggestedValue) || 1) * intentBonus * deterministicMultiplier(`${teamId}:${player.id}:nominate`, 0.97, 1.03);
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
    player: {
      id: player?.id || "",
      name: cleanText(player?.name, 100),
      position: normalizePosition(player?.position),
      suggestedValue: wholeNumber(player?.suggestedValue)
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

function repeatedPositionMultiplier(position, count, required) {
  if (["K", "DST"].includes(position) && count >= Math.max(1, required)) return 0.45;
  if (["QB", "TE"].includes(position) && count >= Math.max(1, required)) return 0.72;
  if (count >= required + 2) return 0.78;
  return 0.92;
}

function recentMarketMultiplier(state) {
  const players = new Map(state.players.map((player) => [player.id, player]));
  const ratios = state.sales.slice(-12).map((sale) => {
    const suggested = Number(players.get(sale.playerId)?.suggestedValue) || 0;
    return suggested > 0 ? Number(sale.amount) / suggested : null;
  }).filter((value) => Number.isFinite(value));
  if (!ratios.length) return 1;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  return boundedNumber(median, 0.8, 1.2, 1);
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

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
