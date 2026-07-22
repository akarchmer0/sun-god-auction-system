const DELAY_PATTERNS = Object.freeze({
  1: Object.freeze([1100, 900, 1300]),
  2: Object.freeze([420, 280, 520]),
  3: Object.freeze([160, 90, 230])
});

export const PATTER_PASSAGE_MAX_CHARS = 1_400;
export const LOCAL_PATTER_PASSAGE_LINES = 3;

export function patterDelayMs({ energy = 2, sequence = 0 } = {}) {
  const level = Math.min(3, Math.max(1, Number(energy) || 2));
  const pattern = DELAY_PATTERNS[level];
  const index = Math.abs(Math.trunc(Number(sequence) || 0)) % pattern.length;
  return pattern[index];
}

export function isLiveAuctionPhase(phase) {
  return ["open", "once", "twice"].includes(phase);
}

export function buildPatterPassage(lines, maxCharacters = PATTER_PASSAGE_MAX_CHARS) {
  const limit = Math.max(1, Math.trunc(Number(maxCharacters) || PATTER_PASSAGE_MAX_CHARS));
  const passageLines = [];
  const seen = new Set();
  for (const value of Array.isArray(lines) ? lines : []) {
    const line = String(value || "").replace(/\s+/g, " ").trim();
    if (!line || seen.has(line.toLowerCase())) continue;
    const candidate = [...passageLines, line].join(" ");
    if (candidate.length > limit) break;
    passageLines.push(line);
    seen.add(line.toLowerCase());
  }
  return { text: passageLines.join(" "), lines: passageLines };
}
