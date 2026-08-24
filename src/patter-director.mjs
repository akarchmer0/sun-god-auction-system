const PERSONALITY_TONE = Object.freeze({
  classic: "quick, warm, mischievous auction rhythm",
  hype: "explosive stadium energy with rising momentum",
  pro: "fast, informed broadcast analysis with dry confidence"
});

export function normalizePatterContext(value = {}) {
  const roster = Array.isArray(value.roster) ? value.roster.slice(0, 18).map((spot) => ({
    name: cleanText(spot?.name, 70),
    position: cleanText(spot?.position, 8).toUpperCase(),
    price: wholeNumber(spot?.price)
  })).filter((spot) => spot.name) : [];
  const recentSales = Array.isArray(value.recentSales) ? value.recentSales.slice(-5).map((sale) => ({
    playerName: cleanText(sale?.playerName, 80),
    managerName: cleanText(sale?.managerName, 70),
    amount: wholeNumber(sale?.amount)
  })).filter((sale) => sale.playerName) : [];
  return {
    event: "live_auction_patter",
    phase: ["open", "once", "twice"].includes(value.phase) ? value.phase : "open",
    playerName: cleanText(value.playerName, 90) || "this player",
    position: cleanText(value.position, 8).toUpperCase() || "PLAYER",
    nflTeam: cleanText(value.nflTeam, 8).toUpperCase(),
    amount: wholeNumber(value.amount),
    nextAmount: Math.max(1, wholeNumber(value.nextAmount)),
    suggestedValue: wholeNumber(value.suggestedValue),
    highBidderManager: cleanText(value.highBidderManager, 70),
    highBidderTeam: cleanText(value.highBidderTeam, 90),
    highBidderBudgetRemaining: wholeNumber(value.highBidderBudgetRemaining),
    bidCount: Math.max(0, wholeNumber(value.bidCount)),
    roster,
    recentSales
  };
}

export function buildPatterInstructions({ personality = "classic", energy = 2 } = {}) {
  const level = Math.min(3, Math.max(1, Number(energy) || 2));
  return `You are the Patter Director for Lucy, a live fantasy-football auctioneer.

Outcome:
- Write exactly one short, funny spoken phrase for Lucy to deliver while bids are open.
- The phrase must be 4 to 12 words, one sentence, natural aloud, and immediately usable without labels or setup.
- Aim for a playful punchline about the price, budget, roster, or room; do not build a setup or multi-line arc.
- Style the phrase as ${PERSONALITY_TONE[personality] || PERSONALITY_TONE.classic}, at energy ${level} of 3.
- Borrow the sustained momentum, escalation, and celebratory release of elite Latin American soccer commentary. Do not imitate an accent, nationality, or language stereotype.

Auction constraints:
- Use only facts in the supplied JSON. Never invent injuries, news, ADP, rankings, rookie status, depth charts, or coach opinions.
- Say names and exact dollar amounts naturally when useful.
- Never say going once, going twice, sold, passed, final, or otherwise perform the official countdown.
- Never claim a new bid, bidder, or price that is not in the supplied JSON.
- Do not roast protected traits or real life. Fantasy-football teasing may target only the bid, price, roster, or draft strategy.
- Avoid every recent spoken line in the input.

Return only JSON matching the requested schema.`;
}

export function buildPatterInput(context, recentLines = []) {
  return JSON.stringify({
    auctionContext: normalizePatterContext(context),
    recentSpokenLines: Array.isArray(recentLines)
      ? recentLines.slice(-8).map((line) => cleanText(line, 220)).filter(Boolean)
      : []
  });
}

export function normalizePatterLines(value) {
  const source = Array.isArray(value) ? value : value?.lines;
  if (!Array.isArray(source) || source.length !== 1) return [];
  const unique = [];
  for (const item of source) {
    let line = cleanText(item, 240)
      .replace(/^(?:line\s*\d+|lucy)\s*:\s*/i, "")
      .replace(/^[“\"']+|[”\"']+$/g, "")
      .trim();
    if ((line.match(/[.!?](?:\s+|$)/g) || []).length > 1) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length > 12) line = `${words.slice(0, 12).join(" ").replace(/[,:;]$/, "")}.`;
    if (words.length < 3 || /\b(?:going once|going twice|sold|passed)\b/i.test(line)) continue;
    if (!unique.some((existing) => existing.toLowerCase() === line.toLowerCase())) unique.push(line);
    if (unique.length === 1) break;
  }
  return unique.length === 1 ? unique : [];
}

export function parsePatterResponse(payload) {
  const outputText = typeof payload?.output_text === "string"
    ? payload.output_text
    : (payload?.output || []).flatMap((item) => item?.content || []).find((part) => part?.type === "output_text")?.text;
  if (!outputText) return [];
  try { return normalizePatterLines(JSON.parse(outputText)); }
  catch { return []; }
}

export const PATTER_RESPONSE_FORMAT = Object.freeze({
  type: "json_schema",
  name: "auctioneer_patter_queue",
  strict: true,
  schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: { type: "string" }
      }
    },
    required: ["lines"],
    additionalProperties: false
  }
});

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maxLength);
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}
