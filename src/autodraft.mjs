import { canTeamRosterPlayer, maxBidForTeam, nextLegalBidAmount, rosterMaximumsForTeam, rosterRequirementsForTeam, ROSTER_POSITIONS } from "./domain.mjs";

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
  target: 1.05
});
const AUTO_BID_STANDARD_DEVIATION = 0.01;
const DEFERRED_CONTROLLER_PHASES = new Set(["ready", "open", "once", "twice", "paused"]);
const CONTROLLER_BOUNDARY_PHASES = new Set(["idle", "sold", "passed"]);

export function autoTeamController(controller) {
  return controller?.type === "auto"
    ? { type: "auto", strategy: "balanced", aggressiveness: boundedNumber(controller.aggressiveness, 0.75, 1.25, 1) }
    : { type: "human", strategy: "balanced", aggressiveness: 1 };
}

export function isAutoTeam(team) {
  return autoTeamController(team?.controller).type === "auto";
}

export function requestTeamControllerChange(state, teamId, requestedType) {
  const targetType = requestedType === "auto" ? "auto" : requestedType === "human" ? "human" : null;
  const team = state?.teams?.find((item) => item.id === teamId);
  if (!team) throw new Error("Choose a valid team.");
  if (!targetType) throw new Error("Choose manual or auto draft control.");
  const activeType = isAutoTeam(team) ? "auto" : "human";
  const shouldDefer = DEFERRED_CONTROLLER_PHASES.has(state?.auction?.phase);
  const pendingControllerType = shouldDefer && targetType !== activeType ? targetType : null;
  const teams = state.teams.map((item) => {
    if (item.id !== teamId) return item;
    if (shouldDefer) return { ...item, pendingControllerType };
    return { ...item, controller: autoTeamController({ type: targetType }), pendingControllerType: null };
  });
  return {
    state: { ...state, teams },
    effective: pendingControllerType ? "next_nomination" : "now",
    activeType: shouldDefer ? activeType : targetType,
    pendingType: pendingControllerType
  };
}

export function applyPendingControllerChanges(state) {
  if (!CONTROLLER_BOUNDARY_PHASES.has(state?.auction?.phase)) return state;
  let changed = false;
  const teams = (state?.teams || []).map((team) => {
    const pendingType = team?.pendingControllerType;
    if (!["auto", "human"].includes(pendingType)) {
      if (team?.pendingControllerType == null) return team;
      changed = true;
      return { ...team, pendingControllerType: null };
    }
    changed = true;
    return { ...team, controller: autoTeamController({ type: pendingType }), pendingControllerType: null };
  });
  return changed ? { ...state, teams } : state;
}

export function localAutoIntents(state, playerId = state?.auction?.playerId, valueProfiles = []) {
  return Object.fromEntries((state?.teams || []).filter(isAutoTeam).map((team) => {
    const decision = localAutoIntent(state, team.id, playerId, valueProfiles);
    return [team.id, { ...decision, provider: "local", model: null }];
  }));
}

export function localAutoIntent(state, teamId, playerId = state?.auction?.playerId, valueProfiles = []) {
  const team = state?.teams?.find((item) => item.id === teamId);
  const player = state?.players?.find((item) => item.id === playerId);
  if (!team || !player || !isAutoTeam(team) || !canTeamRosterPlayer(state, teamId, playerId)) {
    return { intent: "pass", reason: "roster_balance" };
  }

  const counts = rosterPositionCounts(state, team);
  const position = normalizePosition(player.position);
  const requirements = normalizedRequirements(state, team);
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
  if (team.budget <= openSlots + Math.max(2, Math.round(autoDraftSuggestedValue(state, teamId, playerId, valueProfiles) * 0.3))) {
    return { intent: "discount", reason: "budget_preservation" };
  }
  return { intent: "value", reason: "value_opportunity" };
}

export function calculateAutoBidCeiling(state, teamId, playerId = state?.auction?.playerId, intent = null, valueProfiles = []) {
  const team = state?.teams?.find((item) => item.id === teamId);
  const player = state?.players?.find((item) => item.id === playerId);
  if (!team || !player || !isAutoTeam(team) || !canTeamRosterPlayer(state, teamId, playerId)) return 0;

  const normalizedIntent = AUTO_INTENTS.includes(intent) ? intent : localAutoIntent(state, teamId, playerId, valueProfiles).intent;
  if (normalizedIntent === "pass") return state.auction?.nominatorTeamId === teamId ? 1 : 0;
  const standardNormal = deterministicStandardNormal(
    `${team.id}:${player.id}:${state.auction?.nominatorTeamId || ""}:${state.sales?.length || 0}:max-value`
  );

  return Math.min(
    maxBidForTeam(state, teamId),
    sampledAutoBidValue(autoDraftSuggestedValue(state, teamId, playerId, valueProfiles), normalizedIntent, standardNormal)
  );
}

export function sampledAutoBidValue(suggestedValue, intent, standardNormal = 0) {
  if (intent === "pass" || !AUTO_INTENTS.includes(intent)) return 0;
  const value = wholeNumber(suggestedValue);
  const mean = value * INTENT_VALUE_MULTIPLIERS[intent];
  const noise = value * AUTO_BID_STANDARD_DEVIATION * Number(standardNormal || 0);
  return Math.max(0, Math.round(mean + noise));
}

export function chooseAutoBid(state, ceilingOverrides = null, valueProfiles = []) {
  if (!["open", "once", "twice"].includes(state?.auction?.phase)) return null;
  const nextAmount = nextLegalBidAmount(state);
  const playerId = state.auction.playerId;
  const intents = state.auction.autoIntents || {};
  const candidates = state.teams.map((team) => {
    if (!isAutoTeam(team) || team.id === state.auction.highBidderId) return false;
    if (!canTeamRosterPlayer(state, team.id, playerId)) return null;
    const intent = intents[team.id]?.intent || localAutoIntent(state, team.id, playerId, valueProfiles).intent;
    const overridden = ceilingOverrides && Object.prototype.hasOwnProperty.call(ceilingOverrides, team.id)
      ? Number(ceilingOverrides[team.id])
      : null;
    const ceiling = Number.isFinite(overridden)
      ? Math.min(maxBidForTeam(state, team.id), Math.max(team.id === state.auction.nominatorTeamId ? 1 : 0, Math.round(overridden)))
      : calculateAutoBidCeiling(state, team.id, playerId, intent, valueProfiles);
    return nextAmount <= ceiling ? { team, intent, ceiling } : null;
  }).filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => reactionScore(state, a.team.id) - reactionScore(state, b.team.id));
  const candidate = candidates[0];
  const increment = Math.max(1, Number(state.config?.increment) || 1);
  const availableSteps = 1 + Math.floor((candidate.ceiling - nextAmount) / increment);
  const maximumJumpSteps = Math.min(3, availableSteps);
  const jumpSteps = 1 + Math.min(
    maximumJumpSteps - 1,
    Math.floor(deterministicUnit(`${playerId}:${state.auction.bidCount}:${candidate.team.id}:jump`) * maximumJumpSteps)
  );
  return {
    teamId: candidate.team.id,
    amount: nextAmount + (jumpSteps - 1) * increment,
    ceiling: candidate.ceiling,
    intent: candidate.intent
  };
}

export function chooseAutoNomination(state, teamId, valueProfiles = []) {
  const team = state?.teams?.find((item) => item.id === teamId);
  if (!team || !isAutoTeam(team)) return null;
  const available = state.players.filter((player) => player.status === "available" && canTeamRosterPlayer(state, teamId, player.id));
  if (!available.length) return null;
  return available.map((player) => {
    const decision = localAutoIntent(state, teamId, player.id, valueProfiles);
    const intentBonus = decision.intent === "target" ? 1.05 : decision.intent === "value" ? 1 : decision.intent === "discount" ? 0.9 : 0.25;
    const score = autoDraftSuggestedValue(state, teamId, player.id, valueProfiles) * intentBonus * deterministicMultiplier(`${teamId}:${player.id}:nominate`, 0.97, 1.03);
    return { player, score };
  }).sort((a, b) => b.score - a.score || a.player.id.localeCompare(b.player.id))[0].player.id;
}

export function buildAutoIntentContext(state, valueProfiles = []) {
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
      suggestedValue: wholeNumber(player?.suggestedValue)
    },
    league: {
      budget: wholeNumber(state.config?.budget),
      rosterSize: wholeNumber(state.config?.rosterSize),
      rosterRequirements: normalizedRequirements(state),
      rosterMaximums: normalizedMaximums(state),
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
      budgetRemaining: wholeNumber(team.budget),
      rosterSlotsRemaining: Math.max(0, Number(state.config.rosterSize) - team.roster.length),
      maxLegalBid: maxBidForTeam(state, team.id),
      suggestedValue: autoDraftSuggestedValue(state, team.id, player?.id, valueProfiles),
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

export function normalizeAutoIntents(state, decisions, { provider = "local", model = null, valueProfiles = [] } = {}) {
  const allowedTeamIds = new Set(state.teams.filter(isAutoTeam).map((team) => team.id));
  const fallback = localAutoIntents(state, state?.auction?.playerId, valueProfiles);
  const normalized = { ...fallback };
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const teamId = String(decision?.teamId || "");
    if (!allowedTeamIds.has(teamId) || !AUTO_INTENTS.includes(decision?.intent) || !AUTO_INTENT_REASONS.includes(decision?.reason)) continue;
    normalized[teamId] = { intent: decision.intent, reason: decision.reason, provider, model };
  }
  return normalized;
}

export function autoDraftSuggestedValue(state, teamId, playerId, valueProfiles = []) {
  const team = state?.teams?.find((item) => item.id === teamId);
  const player = state?.players?.find((item) => item.id === playerId);
  if (!player) return 0;
  const managerKey = normalizeManagerKey(team?.manager);
  const profile = (Array.isArray(valueProfiles) ? valueProfiles : []).find((item) => item?.managerKey === managerKey);
  const customValue = profile?.values && Object.prototype.hasOwnProperty.call(profile.values, player.id)
    ? Number(profile.values[player.id])
    : NaN;
  return Number.isFinite(customValue) && customValue >= 0
    ? Math.round(customValue)
    : wholeNumber(player.suggestedValue);
}

export function autoBidDelayMs(state, teamId) {
  const minimumDelayMs = 2_000;
  const maximumDelayMs = 5_000;
  return Math.round(
    minimumDelayMs
      + deterministicUnit(`${state.auction.playerId}:${state.auction.bidCount}:${teamId}:delay`)
        * (maximumDelayMs - minimumDelayMs)
  );
}

function rosterPositionCounts(state, team) {
  const counts = Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, 0]));
  for (const spot of team.roster || []) {
    const position = normalizePosition(state.players.find((player) => player.id === spot.playerId)?.position);
    if (position) counts[position] = (counts[position] || 0) + 1;
  }
  return counts;
}

function normalizedRequirements(state, team = state?.teams?.find(isAutoTeam)) {
  const requirements = rosterRequirementsForTeam(state, team);
  return Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Math.max(0, wholeNumber(requirements?.[position]))]));
}

function normalizedMaximums(state, team = state?.teams?.find(isAutoTeam)) {
  const maximums = rosterMaximumsForTeam(state, team);
  return Object.fromEntries(Object.entries(maximums).map(([position, maximum]) => [position, wholeNumber(maximum)]));
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

function normalizeManagerKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
