const DELAY_PATTERNS = Object.freeze({
  1: Object.freeze([1100, 900, 1300]),
  2: Object.freeze([420, 280, 520]),
  3: Object.freeze([160, 90, 230])
});

export function patterDelayMs({ energy = 2, sequence = 0 } = {}) {
  const level = Math.min(3, Math.max(1, Number(energy) || 2));
  const pattern = DELAY_PATTERNS[level];
  const index = Math.abs(Math.trunc(Number(sequence) || 0)) % pattern.length;
  return pattern[index];
}

export function isLiveAuctionPhase(phase) {
  return ["open", "once", "twice"].includes(phase);
}
