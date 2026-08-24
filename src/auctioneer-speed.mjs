export const AUCTIONEER_SPEED_OPTIONS = Object.freeze([
  Object.freeze({ id: "normal", label: "Normal", offset: 0 }),
  Object.freeze({ id: "fast", label: "Fast", offset: 0.08 }),
  Object.freeze({ id: "faster", label: "Faster", offset: 0.16 }),
  Object.freeze({ id: "fastest", label: "Fastest", offset: 0.24 })
]);

const REALTIME_PLAYBACK_RATES = Object.freeze({
  elevenlabs: Object.freeze({ normal: 1.08, fast: 1.14, faster: 1.22, fastest: 1.3 }),
  cartesia: Object.freeze({ normal: 1, fast: 1.03, faster: 1.06, fastest: 1.1 })
});

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

export function realtimePlaybackRate(provider, speed) {
  const normalizedSpeed = normalizeAuctioneerSpeed(speed);
  return REALTIME_PLAYBACK_RATES[String(provider || "").toLowerCase()]?.[normalizedSpeed] || 1;
}
