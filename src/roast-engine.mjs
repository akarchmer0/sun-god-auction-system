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
  classic: "dry, dark, vulgar, and genuinely cutting",
  hype: "high-energy, theatrical, dark, and viciously punchy",
  pro: "deadpan, profane when useful, and brutally analytical"
});

export function shouldRoastSale({ amount, suggestedValue } = {}) {
  const paid = Number(amount);
  const suggested = Number(suggestedValue);
  return Number.isFinite(paid)
    && Number.isFinite(suggested)
    && suggested >= 0
    && paid > suggested;
}

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
  const hasAssignedReference = Number.isInteger(referenceIndex)
    && referenceIndex >= 0
    && referenceIndex < ROAST_REFERENCE_LINES.length;
  const assignment = hasAssignedReference
    ? `- This selected reference is the rotation assignment: ${ROAST_REFERENCE_LINES[referenceIndex]}
- Preserve its core joke, darkness, and comic rhythm. Prefer a close contextual adaptation over a safer rewrite.`
    : `- The initial reference assignments have all been used. Invent a genuinely new dark premise and punchline from the live auction context.
- Do not recycle, paraphrase, or merely swap names into any reference below. Match their bite, not their wording or joke structure.`;
  return `You write one live fantasy-football auction roast for an auctioneer named Lucy.

Outcome:
- Return exactly one natural spoken line, with no quotation marks, labels, markdown, or setup.
- Keep it under 28 words and make it ${PERSONALITY_TONE[personality] || PERSONALITY_TONE.classic}.
- Roast the bid, price, roster construction, or fantasy-football reasoning—not the person's identity.
- Use the supplied manager, player, dollar amount, position, suggested value, or roster context when useful.
- The room explicitly wants dark comedy. Profanity, vulgarity, and obvious hyperbole about death, drugs, injury, incompetence, and financial ruin are allowed and encouraged when they sharpen the joke.
- Be funny before being polite. Do not sanitize the selected reference, replace its dark premise with a wholesome one, or add a moral disclaimer.

Reference rotation:
${assignment}
- Adjust names, pronouns, dollar amounts, and football details to the live context.
- The full house style appears below. Use it as the comedy calibration; do not explain it.
${ROAST_REFERENCE_LINES.map((line, index) => `${index + 1}. ${line}`).join("\n")}

Factual boundary:
- Do not invent actual news, injuries, rookie status, ADP, coach quotes, or depth-chart facts about a real player. When those ideas appear in a reference, frame them as unmistakable comic exaggeration or metaphor without reducing the bite.
- Never use slurs or protected traits as the joke. Everything else may be fair game when aimed at the bid, roster, strategy, or manager's fantasy-football judgment.
- Avoid repeating any recent roast supplied in the input.`;
}

export function buildRoastInput(context, recentRoasts = []) {
  return JSON.stringify({
    auctionContext: normalizeRoastContext(context),
    recentRoasts: Array.isArray(recentRoasts)
      ? recentRoasts.slice(-20).map((line) => cleanText(line, 240)).filter(Boolean)
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
    `${manager} drafts handcuffs like they're hoping the starter dies.`,
    value.hasSuggestedValue
      ? `That ${amount} bid is higher than ${manager} was when they ignored the ${value.suggestedValue}-dollar suggestion.`
      : `That ${amount} bid is higher than ${manager} was when they made it.`,
    `${amount} on a ${position}? Your league fees are basically a donation.`,
    `You built a whole strategy around ${player}, and the strategy needs a walking boot and last rites.`,
    `${value.fantasyTeamName}'s identity is “guys whose names sound familiar.”`,
    `That bid had the confidence of a manager who did zero research and one podcast.`,
    `${player}'s ceiling is another guy's floor, and that guy went undrafted.`,
    `You just spent ${overpay}. Even the depth chart calls him “the other guy.”`
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
