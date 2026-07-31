export const AUCTIONEER_SPEED_OPTIONS = Object.freeze([
  Object.freeze({ id: "normal", label: "Normal", offset: 0 }),
  Object.freeze({ id: "fast", label: "Fast", offset: 0.08 }),
  Object.freeze({ id: "faster", label: "Faster", offset: 0.16 }),
  Object.freeze({ id: "fastest", label: "Fastest", offset: 0.24 })
]);

export function normalizeAuctioneerSpeed(value) {
  return AUCTIONEER_SPEED_OPTIONS.some((option) => option.id === value) ? value : "normal";
}

export function auctioneerSpeedIndex(value) {
  const normalized = normalizeAuctioneerSpeed(value);
  return AUCTIONEER_SPEED_OPTIONS.findIndex((option) => option.id === normalized);
}

export function auctioneerSpeedAt(index) {
  const normalizedIndex = Math.min(
    AUCTIONEER_SPEED_OPTIONS.length - 1,
    Math.max(0, Math.round(Number(index) || 0))
  );
  return AUCTIONEER_SPEED_OPTIONS[normalizedIndex];
}

export function auctioneerSpeedOffset(value) {
  const normalized = normalizeAuctioneerSpeed(value);
  return AUCTIONEER_SPEED_OPTIONS.find((option) => option.id === normalized)?.offset || 0;
}
