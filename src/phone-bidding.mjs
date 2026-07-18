export function easyBidAmounts({ currentBid, nextBid, suggestedValue, maxBid, count = 2 }) {
  const current = nonNegativeInteger(currentBid);
  const minimum = Math.max(current + 1, nonNegativeInteger(nextBid));
  const suggested = nonNegativeInteger(suggestedValue);
  const maximum = nonNegativeInteger(maxBid);
  const target = Math.min(suggested, maximum);
  if (count < 1 || target < minimum || suggested <= current) return [];

  const span = target - current;
  const step = span >= 12 ? 5 : span >= 6 ? 2 : 1;
  const desired = Array.from({ length: count }, (_, index) => current + span * ((index + 1) / (count + 1)));
  const amounts = [];

  for (const value of desired) {
    const rounded = clamp(Math.round(value / step) * step, minimum, target);
    if (!amounts.includes(rounded)) amounts.push(rounded);
  }

  if (amounts.length < count) {
    const candidates = [];
    for (let amount = minimum; amount <= target; amount += 1) {
      const roundness = amount % step === 0 ? 0 : 1;
      const distance = Math.min(...desired.map((value) => Math.abs(value - amount)));
      candidates.push({ amount, roundness, distance });
    }
    candidates.sort((left, right) => left.roundness - right.roundness || left.distance - right.distance || left.amount - right.amount);
    for (const candidate of candidates) {
      if (!amounts.includes(candidate.amount)) amounts.push(candidate.amount);
      if (amounts.length === count) break;
    }
  }

  return amounts.sort((left, right) => left - right).slice(0, count);
}

export function classifyPhoneBidBatch(bids) {
  const cleanBids = Array.isArray(bids)
    ? bids.map((bid) => ({ teamId: String(bid?.teamId || ""), amount: Number(bid?.amount) }))
      .filter((bid) => bid.teamId && Number.isInteger(bid.amount) && bid.amount > 0)
    : [];
  if (!cleanBids.length) return { kind: "none", teamIds: [] };

  const bestByTeam = new Map();
  for (const bid of cleanBids) {
    const existing = bestByTeam.get(bid.teamId);
    if (!existing || bid.amount > existing.amount) bestByTeam.set(bid.teamId, bid);
  }
  const highestAmount = Math.max(...[...bestByTeam.values()].map((bid) => bid.amount));
  const leaders = [...bestByTeam.values()].filter((bid) => bid.amount === highestAmount);
  const teamIds = leaders.map((bid) => bid.teamId);
  if (leaders.length === 1) return { kind: "bid", teamIds, teamId: leaders[0].teamId, amount: highestAmount };
  return { kind: "tie", teamIds, amount: highestAmount };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
