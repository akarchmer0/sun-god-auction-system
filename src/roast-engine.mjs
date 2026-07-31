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

export const ROAST_RESPONSE_FORMAT = Object.freeze({
  type: "json_schema",
  name: "context_edited_roast",
  strict: true,
  schema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 240 },
      priceAngle: { type: "string", enum: ["overpay", "discount", "fair", "unknown"] },
      premiseSupported: { type: "boolean" }
    },
    required: ["text", "priceAngle", "premiseSupported"],
    additionalProperties: false
  }
});

export function shouldRoastSale({ amount } = {}) {
  const paid = Number(amount);
  return Number.isFinite(paid) && paid >= 1;
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
  const playerName = cleanText(value.playerName, 90) || "that player";
  const hasSuggestedValue = Number.isFinite(Number(value.suggestedValue)) && Number(value.suggestedValue) > 0;
  const differenceFromSuggested = hasSuggestedValue ? amount - suggestedValue : null;
  const priceOutcome = !hasSuggestedValue
    ? "unknown"
    : differenceFromSuggested > 0
      ? "overpay"
      : differenceFromSuggested < 0 ? "discount" : "fair";
  const projectedValueTier = !hasSuggestedValue
    ? "unknown"
    : suggestedValue >= 35
      ? "premium"
      : suggestedValue >= 20
        ? "high"
        : suggestedValue >= 10 ? "mid" : "low";
  return {
    event: "player_sold",
    managerName: cleanText(value.managerName, 70) || "the winning manager",
    fantasyTeamName: cleanText(value.fantasyTeamName, 90) || "their team",
    playerName,
    position: cleanText(value.position, 8).toUpperCase() || "PLAYER",
    nflTeam: cleanText(value.nflTeam, 8).toUpperCase(),
    amount,
    suggestedValue,
    hasSuggestedValue,
    differenceFromSuggested,
    priceOutcome,
    projectedValueTier,
    priceSummary: priceOutcome === "unknown"
      ? `${playerName} sold for $${amount}; no draft-sheet value was supplied.`
      : priceOutcome === "fair"
        ? `$${amount} exactly matched the $${suggestedValue} draft-sheet value.`
        : `$${amount} was $${Math.abs(differenceFromSuggested)} ${priceOutcome === "overpay" ? "above" : "below"} the $${suggestedValue} draft-sheet value.`,
    budgetRemaining: wholeNumber(value.budgetRemaining),
    budgetBeforePurchase: wholeNumber(value.budgetBeforePurchase),
    rosterCount: Math.max(0, wholeNumber(value.rosterCount)),
    rosterSize: Math.max(0, wholeNumber(value.rosterSize)),
    bidCount: Math.max(0, wholeNumber(value.bidCount)),
    saleNumber: Math.max(0, wholeNumber(value.saleNumber)),
    roster
  };
}

export function buildRoastInstructions({ personality = "classic", referenceIndex = 0 } = {}) {
  const hasAssignedReference = Number.isInteger(referenceIndex)
    && referenceIndex >= 0
    && referenceIndex < ROAST_REFERENCE_LINES.length;
  const assignment = hasAssignedReference
    ? "- The input contains a candidate joke inspired by the house rotation. It is raw material, not an assignment."
    : "- No reference premise is assigned. Invent a new premise from the supplied auction facts.";
  return `You are the final context editor for one live fantasy-football auction roast spoken by Lucy.

Outcome:
- Edit or replace the candidate and return one logically correct spoken line.
- Keep it under 28 words and make it ${PERSONALITY_TONE[personality] || PERSONALITY_TONE.classic}.
- Roast the bid, price, roster construction, or fantasy-football reasoning—not the person's identity.
- Treat auctionContext as the complete source of truth. Use its manager, player, price, draft-sheet value, priceOutcome, projectedValueTier, bid count, or roster.
- The room explicitly wants dark comedy. Profanity, vulgarity, and obvious hyperbole about death, drugs, injury, incompetence, and financial ruin are allowed and encouraged when they sharpen the joke.
- Be funny before being polite, but logical accuracy beats reference fidelity.

Candidate handling:
${assignment}
- Keep a candidate premise only when the supplied facts support it. Otherwise discard it completely and write a different joke.
- A discount can mock the room for letting value escape or congratulate the buyer sarcastically. It must never accuse the buyer of overpaying.
- An overpay can mock the buyer's spending. It must never call the price a steal, bargain, discount, or underpay.
- A fair price must not claim either an overpay or a bargain.
- For premium or high projectedValueTier players, never call the player a sleeper, unknown, coma patient, benchwarmer, “the other guy,” or someone who would go undrafted.
- Before returning, compare every premise with priceSummary, priceOutcome, projectedValueTier, and the named player.

House style calibration:
${ROAST_REFERENCE_LINES.map((line, index) => `${index + 1}. ${line}`).join("\n")}

Factual boundary:
- Do not invent actual news, injuries, rookie status, ADP, coach quotes, or depth-chart facts about a real player. When those ideas appear in a reference, frame them as unmistakable comic exaggeration or metaphor without reducing the bite.
- Never use slurs or protected traits as the joke. Everything else may be fair game when aimed at the bid, roster, strategy, or manager's fantasy-football judgment.
- Avoid repeating any recent roast supplied in the input.

Return JSON matching the supplied schema:
- text: the final spoken joke only.
- priceAngle: exactly the auctionContext.priceOutcome.
- premiseSupported: true only after the final line passes every logic rule above.`;
}

export function buildRoastInput(context, recentRoasts = [], candidateJoke = "") {
  return JSON.stringify({
    auctionContext: normalizeRoastContext(context),
    candidateJoke: cleanText(candidateJoke, 300),
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
  const difference = Math.abs(value.differenceFromSuggested || 0);
  const lines = value.priceOutcome === "overpay"
    ? [
      `${manager} paid ${amount} for ${player}, ${difference} dollars over the sheet—financial arson with a roster spot.`,
      `${player} was listed at $${value.suggestedValue}; ${manager} added ${difference} dollars because apparently budgets are a cry for help.`,
      `${manager} saw $${value.suggestedValue}, paid ${amount}, and turned arithmetic into a contact sport.`,
      `${difference} dollars over the sheet for ${player}; ${manager}'s budget just left the room in a body bag.`,
      `${manager} paid ${amount} for ${player}. The extra ${difference} dollars were apparently a stupidity tax.`,
      `The sheet said $${value.suggestedValue}; ${manager} heard ${amount} and chose financial self-harm.`,
      `${player} at ${amount} is what happens when confidence murders a calculator.`,
      `${manager} just converted a $${value.suggestedValue} valuation into a ${amount} hostage negotiation.`,
      `That ${amount} bid had all the restraint of a drunk raccoon in a casino.`,
      `${manager}'s roster got ${player}; the budget got an open-casket funeral.`
    ]
    : value.priceOutcome === "discount"
      ? [
        `The room let ${player} fall ${difference} dollars below the sheet; ${manager} just committed robbery with a bid button.`,
        `${manager} got ${player} for ${amount}. Everyone else apparently brought a draft board printed in invisible ink.`,
        `${player} was listed at $${value.suggestedValue} and sold for ${amount}; the room just held a group yard sale.`,
        `${manager} saved ${difference} dollars on ${player} while the rest of the league collectively ate paste.`,
        `${amount} for ${player}? ${manager} didn't win an auction; they looted an unattended budget.`,
        `The sheet said $${value.suggestedValue}. The room stopped at ${amount} and donated the difference to ${manager}.`,
        `${manager} got a ${difference}-dollar discount because apparently everyone else was drafting through a concussion.`,
        `${player} at ${amount} is a steal, and the rest of the room should report its draft strategy missing.`,
        `The league just gift-wrapped ${player} for ${manager} and forgot to charge ${difference} dollars.`,
        `${manager} paid ${amount} for ${player}; the room handled that valuation like a live grenade.`
      ]
      : value.priceOutcome === "fair"
        ? [
          `${manager} paid exactly the sheet price for ${player}; even the chaos took one auction off.`,
          `${player} at ${amount}: perfectly fair, which is the most suspicious thing this room has done all night.`,
          `${manager} matched the board on ${player}. Congratulations on briefly understanding arithmetic.`,
          `${amount} for ${player}; no bargain, no disaster, just aggressively competent paperwork.`,
          `The sheet and ${manager} both said ${amount}. Somewhere, a calculator died of boredom.`,
          `${manager} paid fair value for ${player}, ruining everyone's chance to witness another financial crime.`,
          `${player} lands at exactly ${amount}; the room has accidentally produced an adult decision.`,
          `${manager}'s ${amount} bid was dead on the sheet, a rare outbreak of competence.`,
          `Fair price, sensible bid, correct math—who replaced this league with functioning adults?`,
          `${player} at ${amount} makes perfect sense, so naturally nobody here knows how to react.`
        ]
        : [
          `${manager} paid ${amount} for ${player}; without a sheet value, the room can only confirm the budget is now evidence.`,
          `${player} goes for ${amount}, and ${manager} has volunteered to be the experiment.`,
          `${manager} spent ${amount} on ${player}. The strategy remains classified for public safety.`,
          `${amount} for ${player}; bold enough to be genius, reckless enough to be this league.`,
          `${manager} landed ${player} for ${amount}, pending an investigation by the roster police.`,
          `${player} joins ${value.fantasyTeamName} for ${amount}; the autopsy comes after the season.`,
          `${manager}'s ${amount} bid had conviction. Evidence is still missing.`,
          `${player} at ${amount}; another clean transaction in this deeply unclean draft room.`,
          `${manager} spent ${amount} and called it strategy. The jury is still laughing.`,
          `${amount} buys ${player} and one future argument about what the hell the plan was.`
        ];
  return lines[wrapIndex(referenceIndex, lines.length)];
}

export function parseRoastResponse(payload) {
  const raw = responseOutputText(payload);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      text: normalizeGeneratedRoast(parsed?.text),
      priceAngle: ["overpay", "discount", "fair", "unknown"].includes(parsed?.priceAngle) ? parsed.priceAngle : "",
      premiseSupported: parsed?.premiseSupported === true
    };
  } catch {
    return {
      text: normalizeGeneratedRoast(raw),
      priceAngle: "",
      premiseSupported: false
    };
  }
}

export function roastMatchesContext(text, context) {
  const line = normalizeGeneratedRoast(text);
  if (!line) return false;
  const value = normalizeRoastContext(context);
  const lower = line.toLowerCase();
  const overpayLanguage = /\b(overpay|overpaid|overspent|paid too much|too expensive|above (?:the )?(?:sheet|value)|wasted|blew|torched|burned|financial (?:arson|self-harm|crime)|stupidity tax|donation)\b|set \d+ dollars on fire/;
  const discountLanguage = /\b(steal|bargain|discount|underpaid|underpay|below (?:the )?(?:sheet|value)|saved|robbery|looted|gift-wrapped)\b/;
  const unsupportedLowValuePremise = /\b(sleeper|coma patient|benchwarmer|handcuff|backup|rookie|depth chart|the other guy|went undrafted|walking boot|never heard|names? sound familiar)\b/;
  if (value.priceOutcome === "discount" && overpayLanguage.test(lower)) return false;
  if (value.priceOutcome === "overpay" && discountLanguage.test(lower)) return false;
  if (value.priceOutcome === "fair" && (overpayLanguage.test(lower) || discountLanguage.test(lower))) return false;
  if (["premium", "high"].includes(value.projectedValueTier) && unsupportedLowValuePremise.test(lower)) return false;
  return true;
}

export function extractResponseText(payload) {
  const parsed = parseRoastResponse(payload);
  return parsed?.text || "";
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

function responseOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

function wrapIndex(value, length) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return ((number % length) + length) % length;
}
