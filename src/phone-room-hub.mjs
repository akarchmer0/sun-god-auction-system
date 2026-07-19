const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{12,160}$/;

export class PhoneRoomHub {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.rooms = new Map();
    this.listeners = new Map();
  }

  upsertRoom({ roomId, hostKey, teams }) {
    const id = normalizeRoomId(roomId);
    requireToken(hostKey, "host key");
    const cleanTeams = normalizeTeams(teams);
    const existing = this.rooms.get(id);
    if (existing && existing.hostKey !== hostKey) throw roomError("That room code is already in use.", 409);

    const room = existing || {
      id,
      hostKey,
      claims: new Map(),
      lastBidAtByTeam: new Map(),
      auction: null,
      createdAt: this.now()
    };
    const validTeamIds = new Set(cleanTeams.map((team) => team.id));
    for (const teamId of room.claims.keys()) {
      if (!validTeamIds.has(teamId)) room.claims.delete(teamId);
    }
    room.teams = cleanTeams;
    room.updatedAt = this.now();
    this.rooms.set(id, room);
    const snapshot = this.snapshot(id);
    this.emit(id, { type: "room", room: snapshot });
    return snapshot;
  }

  snapshot(roomId) {
    const room = this.requireRoom(roomId);
    const liveTeams = new Map((room.auction?.teams || []).map((team) => [team.id, team]));
    return {
      roomId: room.id,
      teams: room.teams.map((team) => ({
        ...team,
        ...(liveTeams.get(team.id) || {}),
        claimed: room.claims.has(team.id)
      })),
      auction: room.auction?.auction || null,
      claimedCount: room.claims.size,
      updatedAt: room.updatedAt
    };
  }

  claimTeam({ roomId, teamId, participantToken }) {
    const room = this.requireRoom(roomId);
    requireToken(participantToken, "participant token");
    if (!room.teams.some((team) => team.id === teamId)) throw roomError("Choose a valid team.", 400);
    const existing = room.claims.get(teamId);
    if (existing && existing !== participantToken) throw roomError("That team is already connected to another phone.", 409);

    for (const [claimedTeamId, token] of room.claims) {
      if (token === participantToken && claimedTeamId !== teamId) room.claims.delete(claimedTeamId);
    }
    room.claims.set(teamId, participantToken);
    room.updatedAt = this.now();
    const snapshot = this.snapshot(room.id);
    this.emit(room.id, { type: "room", room: snapshot });
    return snapshot;
  }

  releaseTeam({ roomId, participantToken }) {
    const room = this.requireRoom(roomId);
    requireToken(participantToken, "participant token");
    for (const [teamId, token] of room.claims) {
      if (token === participantToken) room.claims.delete(teamId);
    }
    room.updatedAt = this.now();
    const snapshot = this.snapshot(room.id);
    this.emit(room.id, { type: "room", room: snapshot });
    return snapshot;
  }

  resetClaims({ roomId, hostKey }) {
    const room = this.requireHost(roomId, hostKey);
    room.claims.clear();
    room.updatedAt = this.now();
    const snapshot = this.snapshot(room.id);
    this.emit(room.id, { type: "room", room: snapshot });
    return snapshot;
  }

  updateAuction({ roomId, hostKey, auction, teams }) {
    const room = this.requireHost(roomId, hostKey);
    room.auction = {
      auction: normalizeAuction(auction),
      teams: normalizeLiveTeams(teams, room.teams)
    };
    room.updatedAt = this.now();
    const snapshot = this.snapshot(room.id);
    this.emit(room.id, { type: "state", room: snapshot });
    return snapshot;
  }

  placeBid({ roomId, teamId, participantToken, amount }) {
    const room = this.requireRoom(roomId);
    requireToken(participantToken, "participant token");
    if (room.claims.get(teamId) !== participantToken) throw roomError("This phone is not connected to that team.", 403);
    const auction = room.auction?.auction;
    if (!auction?.acceptingBids) throw roomError("Bidding is not open yet.", 409);
    if (auction.highBidderId === teamId) throw roomError("You already have the high bid.", 409);
    const team = this.snapshot(room.id).teams.find((item) => item.id === teamId);
    if (team?.eligibleForPlayer === false) throw roomError("This player would leave too few spots for your required positions.", 409);
    if (!team || Number(team.maxBid) < Number(auction.nextBid)) throw roomError("Your team cannot place the next legal bid.", 409);
    const bidAmount = amount == null ? Number(auction.nextBid) : Number(amount);
    if (!Number.isInteger(bidAmount)) throw roomError("Enter a whole-dollar bid.", 400);
    if (bidAmount < Number(auction.nextBid)) throw roomError(`Your bid must be at least $${auction.nextBid}.`, 409);
    if (bidAmount > Number(team.maxBid)) throw roomError(`Your team can bid at most $${team.maxBid}.`, 409);

    const receivedAt = this.now();
    const lastBidAt = room.lastBidAtByTeam.get(teamId) || 0;
    if (receivedAt - lastBidAt < 250) throw roomError("Bid already received.", 429);
    room.lastBidAtByTeam.set(teamId, receivedAt);
    const bid = {
      type: "bid",
      id: `${room.id}-${receivedAt}-${teamId}`,
      roomId: room.id,
      teamId,
      amount: bidAmount,
      receivedAt
    };
    this.emit(room.id, bid);
    return bid;
  }

  subscribe(roomId, listener) {
    const room = this.requireRoom(roomId);
    const listeners = this.listeners.get(room.id) || new Set();
    listeners.add(listener);
    this.listeners.set(room.id, listeners);
    listener({ type: "snapshot", room: this.snapshot(room.id) });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(room.id);
    };
  }

  requireRoom(roomId) {
    const id = normalizeRoomId(roomId);
    const room = this.rooms.get(id);
    if (!room) throw roomError("Draft room not found. Check the six-character room code.", 404);
    return room;
  }

  requireHost(roomId, hostKey) {
    const room = this.requireRoom(roomId);
    if (room.hostKey !== hostKey) throw roomError("The host key is invalid for this room.", 403);
    return room;
  }

  emit(roomId, event) {
    for (const listener of this.listeners.get(roomId) || []) listener(event);
  }
}

function normalizeRoomId(value) {
  const roomId = String(value || "").trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(roomId)) throw roomError("Use a valid six-character room code.", 400);
  return roomId;
}

function requireToken(value, label) {
  if (!TOKEN_PATTERN.test(String(value || ""))) throw roomError(`A valid ${label} is required.`, 400);
}

function normalizeTeams(teams) {
  if (!Array.isArray(teams) || teams.length < 2 || teams.length > 16) throw roomError("A room needs 2–16 teams.", 400);
  const clean = teams.map((team, index) => ({
    id: cleanText(team?.id, 80) || `team-${index + 1}`,
    name: cleanText(team?.name, 100) || `Team ${index + 1}`,
    manager: cleanText(team?.manager, 100) || `Manager ${index + 1}`,
    color: /^#[0-9a-f]{6}$/i.test(team?.color) ? team.color : "#d39a20"
  }));
  if (new Set(clean.map((team) => team.id)).size !== clean.length) throw roomError("Every team needs a unique ID.", 400);
  return clean;
}

function normalizeLiveTeams(teams, roomTeams) {
  const allowed = new Set(roomTeams.map((team) => team.id));
  return Array.isArray(teams) ? teams.filter((team) => allowed.has(team?.id)).map((team) => {
    const roster = normalizeRoster(team.roster);
    return {
      id: team.id,
      budget: boundedNumber(team.budget),
      rosterCount: boundedNumber(team.rosterCount ?? roster.length),
      rosterSize: boundedNumber(team.rosterSize),
      maxBid: boundedNumber(team.maxBid),
      eligibleForPlayer: team.eligibleForPlayer !== false,
      roster
    };
  }) : [];
}

function normalizeRoster(roster) {
  return Array.isArray(roster) ? roster.slice(0, 40).map((player) => ({
    playerId: cleanText(player?.playerId, 100),
    name: cleanText(player?.name, 140) || "Unknown player",
    position: cleanText(player?.position, 20) || "FLEX",
    nflTeam: cleanText(player?.nflTeam, 20) || "FA",
    price: boundedNumber(player?.price)
  })) : [];
}

function normalizeAuction(auction) {
  const phase = cleanText(auction?.phase, 30) || "idle";
  return {
    phase,
    amount: boundedNumber(auction?.amount),
    nextBid: boundedNumber(auction?.nextBid),
    highBidderId: cleanText(auction?.highBidderId, 80) || null,
    acceptingBids: Boolean(auction?.acceptingBids),
    player: auction?.player ? {
      id: cleanText(auction.player.id, 100),
      name: cleanText(auction.player.name, 140),
      position: cleanText(auction.player.position, 20),
      nflTeam: cleanText(auction.player.nflTeam, 20),
      suggestedValue: boundedNumber(auction.player.suggestedValue)
    } : null
  };
}

function cleanText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100_000 ? Math.round(number) : 0;
}

function roomError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
