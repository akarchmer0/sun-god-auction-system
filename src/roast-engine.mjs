export const ROAST_REFERENCE_LINES = Object.freeze([
  "He's spending like he's got the answers and drafting like he's got a concussion.",
  "That's not a sleeper, that's a coma patient.",
  "He drafts handcuffs like he's hoping the starter dies.",
  "That guy's ADP is higher than you were when you made this bid.",
  "$28 on a rookie TE? Your league fees are basically a donation.",
  "You built a whole strategy around a guy currently in a walking boot.",
  "Your team's identity is 'guys whose names sound familiar.'",
  "That pick had the confidence of a man who did zero research and one podcast.",
  "That guy's ceiling is another guy's floor, and that guy went undrafted.",
  "You just spent $30 on a player whose own coach calls him 'the other guy.'"
]);

const PERSONALITY_TONE = Object.freeze({
  classic: "dry, quick, and mischievous",
  hype: "high-energy, theatrical, and punchy",
  pro: "deadpan, analytical, and cutting"
});

export function normalizeRoastContext(value = {}) {
  const roster = Array.isArray(value.roster) ? value.roster.slice(0, 18).map((spot) => ({
    name: cleanText(spot?.name, 70),
    position: cleanText(spot?.position, 8).toUpperCase(),
    nflTeam: cleanText(spot?.nflTeam, 8).toUpperCase(),
    price: wholeNumber(spot?.price)
  })).filter((spot) => spot.name) : [];
  const amount = wholeNumber(value.amount);
  const suggestedValue = wholeNumber(value.suggestedValue);
  const hasSuggestedValue = Number.isFinite(Number(value.suggestedValue)) && Number(value.suggestedValue) > 0;
  return {
    event: "player_sold",
    managerName: cleanText(value.managerName, 70) || "the winning manager",
    fantasyTeamName: cleanText(value.fantasyTeamName, 90) || "their team",
    playerName: cleanText(value.playerName, 90) || "that player",
    position: cleanText(value.position, 8).toUpperCase() || "PLAYER",
    nflTeam: cleanText(value.nflTeam, 8).toUpperCase(),
    amount,
    suggestedValue,
    hasSuggestedValue,
    differenceFromSuggested: hasSuggestedValue ? amount - suggestedValue : null,
    budgetRemaining: wholeNumber(value.budgetRemaining),
    rosterCount: Math.max(0, wholeNumber(value.rosterCount)),
    rosterSize: Math.max(0, wholeNumber(value.rosterSize)),
    roster
  };
}

export function buildRoastInstructions({ personality = "classic", referenceIndex = 0 } = {}) {
  const selected = ROAST_REFERENCE_LINES[wrapIndex(referenceIndex, ROAST_REFERENCE_LINES.length)];
  return `You write one live fantasy-football auction roast for an auctioneer named Lucy.

Outcome:
- Return exactly one natural spoken line, with no quotation marks, labels, markdown, or setup.
- Keep it under 28 words and make it ${PERSONALITY_TONE[personality] || PERSONALITY_TONE.classic}.
- Roast the bid, price, roster construction, or fantasy-football reasoning—not the person's identity.
- Use the supplied manager, player, dollar amount, position, suggested value, or roster context when useful.

Reference rotation:
- This selected reference is the rotation assignment: ${selected}
- Preserve its core joke or comic rhythm. Only replace its premise when the truth constraints make that premise unsupported by the live context.
- Adjust names, pronouns, dollar amounts, and football details to the live context.
- The full house style appears below. Echo or remix it; do not explain it.
${ROAST_REFERENCE_LINES.map((line, index) => `${index + 1}. ${line}`).join("\n")}

Truth and taste constraints:
- Do not invent an injury, rookie status, ADP, coach quote, depth-chart relationship, or news fact. If a selected reference depends on a fact not supplied, preserve its comic rhythm but replace that premise with supplied facts.
- Fantasy-football hyperbole from the references is allowed, but never present a real medical, drug, death, or injury claim as fact.
- No slurs, protected-trait jokes, appearance jokes, threats, sexual content, or attacks on someone's real life. Keep the target inside this fantasy draft.
- Avoid repeating any recent roast supplied in the input.`;
}

export function buildRoastInput(context, recentRoasts = []) {
  return JSON.stringify({
    auctionContext: normalizeRoastContext(context),
    recentRoasts: Array.isArray(recentRoasts)
      ? recentRoasts.slice(-5).map((line) => cleanText(line, 240)).filter(Boolean)
      : []
  });
}

export function curatedRoast(context, referenceIndex = 0) {
  const value = normalizeRoastContext(context);
  const manager = value.managerName;
  const player = value.playerName;
  const amount = `$${value.amount}`;
  const position = value.position;
  const overpay = value.hasSuggestedValue && value.differenceFromSuggested > 0
    ? `${amount} for a ${value.suggestedValue}-dollar suggestion`
    : `${amount} on ${player}`;
  const lines = [
    `${manager} is spending like they've got the answers and drafting like they've got a concussion.`,
    `${player} at ${amount}? That's not a sleeper, that's a coma patient.`,
    `${manager} drafts roster insurance like they're trying to collect on the policy.`,
    value.hasSuggestedValue
      ? `The ${value.suggestedValue}-dollar suggestion was higher than the logic behind this ${amount} bid.`
      : `The draft board had more value before this ${amount} bid showed up.`,
    `${amount} on a ${position}? Your league fees are basically a donation.`,
    `You built a whole strategy around ${player}, and the strategy already needs crutches.`,
    `${value.fantasyTeamName}'s identity is “guys whose names sound familiar.”`,
    `That bid had the confidence of a manager who did zero research and one podcast.`,
    `${player}'s ceiling is another player's floor, and ${manager} just paid ${amount} for the elevator.`,
    `You just spent ${overpay}. Even the draft board is asking who the other guy was.`
  ];
  return lines[wrapIndex(referenceIndex, lines.length)];
}

export function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return normalizeGeneratedRoast(payload.output_text);
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return normalizeGeneratedRoast(part.text);
    }
  }
  return "";
}

export function normalizeGeneratedRoast(value) {
  let text = cleanText(value, 300)
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^(?:roast|lucy)\s*:\s*/i, "")
    .replace(/^[“\"']+|[”\"']+$/g, "")
    .trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 36) text = `${words.slice(0, 36).join(" ").replace(/[,:;]$/, "")}.`;
  return text;
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maxLength);
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function wrapIndex(value, length) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return ((number % length) + length) % length;
}
