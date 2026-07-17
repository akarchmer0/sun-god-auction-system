export const MIN_BID = 1;

export function createDraft({ players, teams, budget = 200, rosterSize = 15, increment = 1 }) {
  return {
    config: { budget, rosterSize, increment },
    players: players.map((player) => ({ ...player })),
    teams: teams.map((team) => ({ ...team, budget, roster: [...(team.roster || [])] })),
    queue: players.map((player) => player.id),
    auction: emptyAuction(),
    sales: [],
    log: [{ id: cryptoId(), type: "system", message: "Draft room opened", at: Date.now() }]
  };
}

export function emptyAuction() {
  return {
    playerId: null,
    phase: "idle",
    amount: 0,
    highBidderId: null,
    bidCount: 0,
    lastBidAt: null
  };
}

export function maxBidForTeam(state, teamId) {
  const team = state.teams.find((item) => item.id === teamId);
  if (!team) return 0;
  const openSlotsAfterPurchase = Math.max(0, state.config.rosterSize - team.roster.length - 1);
  return Math.max(0, team.budget - openSlotsAfterPurchase * MIN_BID);
}

export function nominatePlayer(state, playerId) {
  const player = state.players.find((item) => item.id === playerId);
  if (!player || player.status !== "available") throw new Error("That player is not available.");
  if (!["idle", "sold", "passed"].includes(state.auction.phase)) throw new Error("Finish the current auction first.");
  return {
    ...state,
    auction: { ...emptyAuction(), playerId, phase: "ready" },
    queue: [playerId, ...state.queue.filter((id) => id !== playerId)],
    log: addLog(state.log, "nomination", `${player.name} nominated`)
  };
}

export function openAuction(state) {
  if (!state.auction.playerId) throw new Error("Nominate a player first.");
  if (!["ready", "paused"].includes(state.auction.phase)) return state;
  return {
    ...state,
    auction: { ...state.auction, phase: state.auction.amount > 0 ? "open" : "open" },
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
  const nextBid = requestedAmount == null
    ? Math.max(MIN_BID, state.auction.amount + state.config.increment)
    : Number(requestedAmount);
  if (!Number.isInteger(nextBid) || nextBid < Math.max(MIN_BID, state.auction.amount + state.config.increment)) {
    throw new Error(`The next bid must be at least $${Math.max(MIN_BID, state.auction.amount + state.config.increment)}.`);
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

export function advanceCountdown(state) {
  if (state.auction.phase === "open") {
    if (!state.auction.highBidderId) return {
      ...state,
      auction: { ...state.auction, phase: "passed" },
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
  const sale = { id: cryptoId(), playerId, teamId: highBidderId, amount, at: Date.now() };
  return {
    ...state,
    players: state.players.map((item) => item.id === playerId ? { ...item, status: "sold" } : item),
    teams: state.teams.map((item) => item.id === highBidderId
      ? { ...item, budget: item.budget - amount, roster: [...item.roster, { playerId, price: amount }] }
      : item),
    queue: state.queue.filter((id) => id !== playerId),
    auction: { ...state.auction, phase: "sold" },
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
    auction: { ...emptyAuction(), playerId: sale.playerId, phase: "ready" },
    sales: state.sales.slice(0, -1),
    log: addLog(state.log, "undo", `Reversed the sale of ${player.name}`)
  };
}

export function currentPlayer(state) {
  return state.players.find((item) => item.id === state.auction.playerId) || null;
}

function addLog(log, type, message) {
  return [...log, { id: cryptoId(), type, message, at: Date.now() }];
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
