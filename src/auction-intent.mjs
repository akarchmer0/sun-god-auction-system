export function normalizeCloudAuctionIntent(value, teamIds = []) {
  const validTeamIds = new Set(teamIds);
  const confidence = Number(value?.confidence);
  const managerId = validTeamIds.has(value?.manager_id) ? value.manager_id : null;
  const amount = Number.isInteger(value?.amount) && value.amount > 0 ? value.amount : null;

  if (value?.intent !== "bid") {
    return { intent: "ignore", amount: null, managerId: null, confidence: Number.isFinite(confidence) ? confidence : 0 };
  }

  return {
    intent: "bid",
    amount,
    managerId,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0
  };
}

export function hasPotentialBidSignal(command, namedTeam) {
  return Boolean(command?.isBid || namedTeam || command?.amount !== null);
}
