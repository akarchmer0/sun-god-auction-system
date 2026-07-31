const POSITIONS = new Set(["QB", "RB", "WR", "TE", "FLEX", "K", "DST"]);
const PLAYER_STATUSES = new Set(["available", "sold"]);
const AUCTION_PHASES = new Set(["idle", "ready", "open", "once", "twice", "paused", "sold", "passed"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

export function validateDraftState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw invalid("Draft state must be an object.");
  if (!Array.isArray(state.players) || state.players.length < 1 || state.players.length > 5_000) throw invalid("Draft state needs 1–5,000 players.");
  if (!Array.isArray(state.teams) || state.teams.length < 2 || state.teams.length > 16) throw invalid("Draft state needs 2–16 teams.");
  if (!Array.isArray(state.sales) || state.sales.length > 5_000) throw invalid("The sale ledger is invalid.");
  if (!Array.isArray(state.queue) || state.queue.length > 5_000) throw invalid("The nomination queue is invalid.");

  const config = state.config || {};
  requireInteger(config.budget, 20, 100_000, "budget");
  requireInteger(config.rosterSize, 1, 50, "roster size");
  requireInteger(config.increment, 1, 1_000, "bid increment");

  const playerIds = new Set();
  for (const player of state.players) {
    const id = requireId(player?.id, "player ID");
    if (playerIds.has(id)) throw invalid("Player IDs must be unique.");
    playerIds.add(id);
    requireText(player?.name, 140, "player name");
    if (!POSITIONS.has(player?.position)) throw invalid("A player position is invalid.");
    if (!/^(?:[A-Z]{2,4}|FA)$/.test(player?.nflTeam)) throw invalid("An NFL team abbreviation is invalid.");
    requireInteger(player?.suggestedValue, 0, 100_000, "suggested value");
    if (!PLAYER_STATUSES.has(player?.status)) throw invalid("A player status is invalid.");
  }

  const teamIds = new Set();
  for (const team of state.teams) {
    const id = requireId(team?.id, "team ID");
    if (teamIds.has(id)) throw invalid("Team IDs must be unique.");
    teamIds.add(id);
    requireText(team?.name, 100, "team name");
    requireText(team?.manager, 100, "manager name");
    if (!/^#[0-9a-f]{6}$/i.test(team?.color)) throw invalid("A team color is invalid.");
    requireInteger(team?.budget, 0, 100_000, "team budget");
    if (!Array.isArray(team?.roster) || team.roster.length > config.rosterSize) throw invalid("A team roster is invalid.");
    for (const spot of team.roster) {
      if (!playerIds.has(spot?.playerId)) throw invalid("A roster references an unknown player.");
      requireInteger(spot?.price, 0, 100_000, "sale price");
    }
  }

  for (const id of state.queue) if (!playerIds.has(id)) throw invalid("The queue references an unknown player.");
  if (!AUCTION_PHASES.has(state.auction?.phase)) throw invalid("The auction phase is invalid.");
  if (state.auction?.playerId != null && !playerIds.has(state.auction.playerId)) throw invalid("The auction references an unknown player.");
  if (state.auction?.highBidderId != null && !teamIds.has(state.auction.highBidderId)) throw invalid("The auction references an unknown team.");
  for (const sale of state.sales) {
    requireId(sale?.id, "sale ID");
    if (!playerIds.has(sale?.playerId) || !teamIds.has(sale?.teamId)) throw invalid("A sale references unknown draft data.");
    requireInteger(sale?.amount, 1, 100_000, "sale amount");
  }
  return state;
}

function requireId(value, label) {
  const id = String(value || "");
  if (!ID_PATTERN.test(id)) throw invalid(`The ${label} is invalid.`);
  return id;
}

function requireText(value, maximum, label) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(`The ${label} is invalid.`);
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw invalid(`The ${label} is invalid.`);
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
