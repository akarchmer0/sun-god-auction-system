export const MIN_BID = 1;

export const ROSTER_POSITIONS = ["QB", "RB", "WR", "TE", "FLEX", "K", "DST"];
export const AUTO_ROSTER_REQUIREMENTS = Object.freeze({ QB: 2, RB: 3, WR: 4, TE: 1, FLEX: 0, K: 1, DST: 1 });
export const AUTO_ROSTER_MAXIMUMS = Object.freeze({ QB: 2, K: 1, DST: 1 });
export const AUTO_ROSTER_SIZE = 15;
export const DEFAULT_COUNTDOWN_SECONDS = Object.freeze({ once: 5.2, twice: 4.2 });

export function createDraft({
  players,
  teams,
  budget = 200,
  rosterSize = 15,
  increment = 1,
  rosterRequirements = {},
  nominationOrder = null,
  countdownOnceSeconds = DEFAULT_COUNTDOWN_SECONDS.once,
  countdownTwiceSeconds = DEFAULT_COUNTDOWN_SECONDS.twice
}) {
  const order = normalizeNominationOrder(nominationOrder, teams);
  return {
    config: {
      budget,
      rosterSize,
      increment,
      rosterRequirements: normalizeRosterRequirements(rosterRequirements),
      countdownOnceSeconds: normalizeCountdownSeconds(countdownOnceSeconds, DEFAULT_COUNTDOWN_SECONDS.once),
      countdownTwiceSeconds: normalizeCountdownSeconds(countdownTwiceSeconds, DEFAULT_COUNTDOWN_SECONDS.twice)
    },
    players: players.map((player) => ({ ...player })),
    teams: teams.map((team) => ({ ...team, budget, roster: [...(team.roster || [])] })),
    queue: players.map((player) => player.id),
    auction: emptyAuction(),
    nomination: { order, currentIndex: 0 },
    sales: [],
    log: [{ id: cryptoId(), type: "system", message: "Draft room opened", at: Date.now() }]
  };
}

export function normalizeCountdownSeconds(value, fallback) {
  const seconds = Number(value);
  const safeFallback = Number(fallback) || DEFAULT_COUNTDOWN_SECONDS.once;
  if (!Number.isFinite(seconds)) return safeFallback;
  return Math.round(Math.min(20, Math.max(2, seconds)) * 10) / 10;
}

export function countdownDelayMs(config, phase) {
  if (phase === "open") return 8_000;
  if (phase === "once") {
    return normalizeCountdownSeconds(config?.countdownOnceSeconds, DEFAULT_COUNTDOWN_SECONDS.once) * 1_000;
  }
  if (phase === "twice") {
    return normalizeCountdownSeconds(config?.countdownTwiceSeconds, DEFAULT_COUNTDOWN_SECONDS.twice) * 1_000;
  }
  return 0;
}

export function emptyAuction() {
  return {
    playerId: null,
    phase: "idle",
    amount: 0,
    highBidderId: null,
    nominatorTeamId: null,
    bidCount: 0,
    lastBidAt: null,
    autoIntents: {},
    autoIntentStatus: "idle"
  };
}

export function maxBidForTeam(state, teamId) {
  const team = state.teams.find((item) => item.id === teamId);
  if (!team) return 0;
  const openSlotsAfterPurchase = Math.max(0, state.config.rosterSize - team.roster.length - 1);
  return Math.max(0, team.budget - openSlotsAfterPurchase * MIN_BID);
}

export function currentNominator(state) {
  return currentNominatorEntry(state)?.team || null;
}

function currentNominatorEntry(state) {
  const order = state.nomination?.order || state.teams.map((team) => team.id);
  if (!order.length) return null;
  const start = Number(state.nomination?.currentIndex || 0) % order.length;
  for (let offset = 0; offset < order.length; offset += 1) {
    const index = (start + offset) % order.length;
    const team = state.teams.find((item) => item.id === order[index]);
    if (team && team.roster.length < state.config.rosterSize) return { team, index };
  }
  return null;
}

export function canTeamRosterPlayer(state, teamId, playerId) {
  const team = state.teams.find((item) => item.id === teamId);
  const player = state.players.find((item) => item.id === playerId);
  if (!team || !player || team.roster.length >= state.config.rosterSize) return false;
  const maximum = rosterMaximumsForTeam(state, team)[String(player.position || "").toUpperCase()];
  if (maximum != null && rosterPositionCount(state, team.roster, player.position) >= maximum) return false;
  const rosterAfterPurchase = [...team.roster, { playerId: player.id, price: 0 }];
  const openSlots = state.config.rosterSize - rosterAfterPurchase.length;
  return missingRequiredSlots(state, rosterAfterPurchase, rosterRequirementsForTeam(state, team)) <= openSlots;
}

export function rosterRequirementsForTeam(state, team) {
  if (usesStandardAutoRoster(state, team)) {
    return { ...AUTO_ROSTER_REQUIREMENTS };
  }
  return normalizeRosterRequirements(state?.config?.rosterRequirements);
}

export function rosterMaximumsForTeam(state, team) {
  return usesStandardAutoRoster(state, team) ? { ...AUTO_ROSTER_MAXIMUMS } : {};
}

export function nominatePlayer(state, playerId) {
  const player = state.players.find((item) => item.id === playerId);
  const nominator = currentNominatorEntry(state);
  if (!player || player.status !== "available") throw new Error("That player is not available.");
  if (!["idle", "sold", "passed"].includes(state.auction.phase)) throw new Error("Finish the current auction first.");
  if (!nominator) throw new Error("No team has an open roster spot for another nomination.");
  if (!canTeamRosterPlayer(state, nominator.team.id, playerId)) {
    throw new Error(`${nominator.team.name} cannot nominate that player and still complete its required positions.`);
  }
  if (maxBidForTeam(state, nominator.team.id) < MIN_BID) throw new Error(`${nominator.team.name} cannot afford the $1 opening bid.`);
  return {
    ...state,
    auction: {
      ...emptyAuction(),
      playerId,
      phase: "ready",
      amount: MIN_BID,
      highBidderId: nominator.team.id,
      nominatorTeamId: nominator.team.id,
      bidCount: 1,
      lastBidAt: Date.now()
    },
    nomination: { ...(state.nomination || { order: state.teams.map((team) => team.id) }), currentIndex: nominator.index },
    queue: [playerId, ...state.queue.filter((id) => id !== playerId)],
    log: addLog(state.log, "nomination", `${nominator.team.name} nominated ${player.name} for $1`)
  };
}

export function openAuction(state) {
  if (!state.auction.playerId) throw new Error("Nominate a player first.");
  if (!["ready", "paused"].includes(state.auction.phase)) return state;
  return {
    ...state,
    auction: {
      ...state.auction,
      phase: "open",
      amount: state.auction.highBidderId ? state.auction.amount : MIN_BID
    },
    log: addLog(state.log, "auction", `Bidding opened for ${currentPlayer(state).name}`)
  };
}

export function pauseAuction(state) {
  if (!["open", "once", "twice"].includes(state.auction.phase)) return state;
  return { ...state, auction: { ...state.auction, phase: "paused" } };
}

export function placeBid(state, teamId, requestedAmount) {
  if (!["open", "once", "twice"].includes(state.auction.phase)) throw new Error("Bidding is not open.");
  if (state.auction.highBidderId === teamId) throw new Error("That team already has the high bid.");
  const team = state.teams.find((item) => item.id === teamId);
  if (!team) throw new Error("Choose a valid team.");
  if (team.roster.length >= state.config.rosterSize) throw new Error(`${team.name}'s roster is full.`);
  if (!canTeamRosterPlayer(state, teamId, state.auction.playerId)) {
    throw new Error(`${team.name} must leave enough roster spots to meet its position requirements.`);
  }
  const minimumBid = nextLegalBidAmount(state);
  const nextBid = requestedAmount == null ? minimumBid : Number(requestedAmount);
  if (!Number.isInteger(nextBid) || nextBid < minimumBid) {
    throw new Error(`The next bid must be at least $${minimumBid}.`);
  }
  const maxBid = maxBidForTeam(state, teamId);
  if (nextBid > maxBid) throw new Error(`${team.name} can bid at most $${maxBid} and still fill its roster.`);
  return {
    ...state,
    auction: {
      ...state.auction,
      phase: "open",
      amount: nextBid,
      highBidderId: teamId,
      bidCount: state.auction.bidCount + 1,
      lastBidAt: Date.now()
    },
    log: addLog(state.log, "bid", `${team.name} bid $${nextBid}`)
  };
}

export function nextLegalBidAmount(state) {
  const openingPrice = Math.max(MIN_BID, Number(state?.auction?.amount) || 0);
  if (!state?.auction?.highBidderId) return openingPrice;
  return openingPrice + Math.max(1, Number(state?.config?.increment) || 1);
}

export function advanceCountdown(state) {
  if (state.auction.phase === "open") {
    if (!state.auction.highBidderId) return {
      ...state,
      auction: { ...state.auction, phase: "passed" },
      nomination: advanceNomination(state),
      queue: [...state.queue.filter((id) => id !== state.auction.playerId), state.auction.playerId],
      log: addLog(state.log, "pass", `${currentPlayer(state).name} passed without a bid`)
    };
    return { ...state, auction: { ...state.auction, phase: "once" } };
  }
  if (state.auction.phase === "once") return { ...state, auction: { ...state.auction, phase: "twice" } };
  if (state.auction.phase === "twice") return sellPlayer(state);
  return state;
}

export function sellPlayer(state) {
  const { playerId, highBidderId, amount } = state.auction;
  if (!playerId || !highBidderId || amount < MIN_BID) throw new Error("A valid high bid is required before selling.");
  const player = state.players.find((item) => item.id === playerId);
  const team = state.teams.find((item) => item.id === highBidderId);
  const sale = {
    id: cryptoId(),
    playerId,
    teamId: highBidderId,
    amount,
    nominatorTeamId: state.auction.nominatorTeamId,
    nominationIndex: state.nomination?.currentIndex || 0,
    at: Date.now()
  };
  const updatedTeams = state.teams.map((item) => item.id === highBidderId
    ? { ...item, budget: item.budget - amount, roster: [...item.roster, { playerId, price: amount }] }
    : item);
  return {
    ...state,
    players: state.players.map((item) => item.id === playerId ? { ...item, status: "sold" } : item),
    teams: updatedTeams,
    queue: state.queue.filter((id) => id !== playerId),
    auction: { ...state.auction, phase: "sold" },
    nomination: advanceNomination({ ...state, teams: updatedTeams }),
    sales: [...state.sales, sale],
    log: addLog(state.log, "sale", `${player.name} sold to ${team.name} for $${amount}`)
  };
}

export function moveToNextPlayer(state) {
  const nextId = state.queue.find((id) => state.players.find((player) => player.id === id)?.status === "available");
  if (!nextId) return { ...state, auction: emptyAuction() };
  return nominatePlayer({ ...state, auction: emptyAuction() }, nextId);
}

export function undoLastSale(state) {
  const sale = state.sales.at(-1);
  if (!sale) throw new Error("There is no sale to undo.");
  const player = state.players.find((item) => item.id === sale.playerId);
  return {
    ...state,
    players: state.players.map((item) => item.id === sale.playerId ? { ...item, status: "available" } : item),
    teams: state.teams.map((team) => team.id === sale.teamId
      ? { ...team, budget: team.budget + sale.amount, roster: team.roster.filter((spot) => spot.playerId !== sale.playerId) }
      : team),
    queue: [sale.playerId, ...state.queue.filter((id) => id !== sale.playerId)],
    auction: { ...emptyAuction(), playerId: sale.playerId, phase: "ready", amount: MIN_BID, nominatorTeamId: sale.nominatorTeamId || null },
    nomination: { ...(state.nomination || { order: state.teams.map((team) => team.id) }), currentIndex: sale.nominationIndex ?? Math.max(0, (state.nomination?.currentIndex || 1) - 1) },
    sales: state.sales.slice(0, -1),
    log: addLog(state.log, "undo", `Reversed the sale of ${player.name}`)
  };
}

export function correctSale(state, saleId, { teamId, amount, returnToPool = false } = {}) {
  const saleIndex = state.sales.findIndex((sale) => sale.id === saleId);
  if (saleIndex < 0) throw new Error("Choose a valid sale to correct.");
  const original = state.sales[saleIndex];
  let sales;
  if (returnToPool) {
    sales = state.sales.filter((sale) => sale.id !== saleId);
  } else {
    if (!state.teams.some((team) => team.id === teamId)) throw new Error("Choose a valid buyer.");
    if (!Number.isInteger(Number(amount)) || Number(amount) < MIN_BID) throw new Error("Enter a valid whole-dollar sale price.");
    sales = state.sales.map((sale) => sale.id === saleId ? { ...sale, teamId, amount: Number(amount), correctedAt: Date.now() } : sale);
  }
  const rebuilt = rebuildFromSales(state, sales);
  const returnedPlayer = returnToPool ? state.players.find((player) => player.id === original.playerId) : null;
  return {
    ...rebuilt,
    queue: returnedPlayer ? [returnedPlayer.id, ...rebuilt.queue.filter((id) => id !== returnedPlayer.id)] : rebuilt.queue,
    auction: { ...emptyAuction(), phase: "paused", playerId: returnedPlayer?.id || null, amount: returnedPlayer ? MIN_BID : 0, nominatorTeamId: original.nominatorTeamId || null },
    nomination: returnToPool
      ? { ...state.nomination, currentIndex: original.nominationIndex ?? state.nomination?.currentIndex ?? 0 }
      : rebuilt.nomination,
    log: addLog(state.log, "correction", returnToPool
      ? `Returned ${returnedPlayer?.name || "player"} to the available pool`
      : `Corrected ${state.players.find((player) => player.id === original.playerId)?.name || "sale"} to ${state.teams.find((team) => team.id === teamId)?.name} for $${amount}`)
  };
}

export function rebuildFromSales(state, sales = state.sales) {
  const playersById = new Map(state.players.map((player) => [player.id, player]));
  const teamsById = new Map(state.teams.map((team) => [team.id, { ...team, budget: state.config.budget, roster: [] }]));
  const soldPlayerIds = new Set();
  for (const sale of sales) {
    if (soldPlayerIds.has(sale.playerId)) throw new Error("A player cannot appear in more than one sale.");
    const player = playersById.get(sale.playerId);
    const team = teamsById.get(sale.teamId);
    if (!player || !team) throw new Error("A corrected sale references missing draft data.");
    if (!Number.isInteger(Number(sale.amount)) || Number(sale.amount) < MIN_BID) throw new Error("Every sale needs a valid whole-dollar price.");
    if (team.roster.length >= state.config.rosterSize) throw new Error(`${team.name}'s corrected roster would be over capacity.`);
    team.budget -= Number(sale.amount);
    team.roster.push({ playerId: sale.playerId, price: Number(sale.amount) });
    const reserve = state.config.rosterSize - team.roster.length;
    if (team.budget < reserve) throw new Error(`${team.name}'s corrected spending would violate the roster reserve.`);
    soldPlayerIds.add(sale.playerId);
  }
  const lastSale = sales.at(-1);
  return {
    ...state,
    players: state.players.map((player) => ({ ...player, status: soldPlayerIds.has(player.id) ? "sold" : "available" })),
    teams: state.teams.map((team) => teamsById.get(team.id)),
    queue: state.players.filter((player) => !soldPlayerIds.has(player.id)).map((player) => player.id),
    sales: sales.map((sale) => ({ ...sale })),
    nomination: {
      ...(state.nomination || { order: state.teams.map((team) => team.id) }),
      currentIndex: lastSale ? ((Number(lastSale.nominationIndex) || 0) + 1) % state.teams.length : 0
    }
  };
}

export function currentPlayer(state) {
  return state.players.find((item) => item.id === state.auction.playerId) || null;
}

function missingRequiredSlots(state, roster, requirements = normalizeRosterRequirements(state.config.rosterRequirements)) {
  const counts = new Map();
  for (const spot of roster) {
    const position = state.players.find((player) => player.id === spot.playerId)?.position?.toUpperCase();
    if (position) counts.set(position, (counts.get(position) || 0) + 1);
  }
  let missing = 0;
  for (const position of ROSTER_POSITIONS.filter((item) => item !== "FLEX")) {
    missing += Math.max(0, requirements[position] - (counts.get(position) || 0));
  }
  const flexEligible = ["RB", "WR", "TE"].reduce((total, position) => {
    return total + Math.max(0, (counts.get(position) || 0) - requirements[position]);
  }, 0);
  missing += Math.max(0, requirements.FLEX - flexEligible);
  return missing;
}

function rosterPositionCount(state, roster, position) {
  const normalizedPosition = String(position || "").toUpperCase();
  return roster.reduce((count, spot) => (
    String(state.players.find((player) => player.id === spot.playerId)?.position || "").toUpperCase() === normalizedPosition
      ? count + 1
      : count
  ), 0);
}

function usesStandardAutoRoster(state, team) {
  return team?.controller?.type === "auto" && Number(state?.config?.rosterSize) === AUTO_ROSTER_SIZE;
}

function normalizeRosterRequirements(requirements = {}) {
  return Object.fromEntries(ROSTER_POSITIONS.map((position) => [
    position,
    Math.max(0, Number.parseInt(requirements?.[position], 10) || 0)
  ]));
}

function normalizeNominationOrder(order, teams) {
  const teamIds = teams.map((team) => team.id);
  const valid = Array.isArray(order) ? order.filter((id) => teamIds.includes(id)) : [];
  return [...new Set([...valid, ...teamIds])];
}

function advanceNomination(state) {
  const order = state.nomination?.order || state.teams.map((team) => team.id);
  if (!order.length) return { order: [], currentIndex: 0 };
  const start = Number(state.nomination?.currentIndex || 0);
  for (let offset = 1; offset <= order.length; offset += 1) {
    const currentIndex = (start + offset) % order.length;
    const team = state.teams.find((item) => item.id === order[currentIndex]);
    if (team && team.roster.length < state.config.rosterSize) return { order, currentIndex };
  }
  return { order, currentIndex: start % order.length };
}

function addLog(log, type, message) {
  return [...log, { id: cryptoId(), type, message, at: Date.now() }];
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
