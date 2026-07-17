export function parseSpokenBid(transcript) {
  const normalized = String(transcript || "")
    .toLowerCase()
    .replace(/\b(bid(?:s|ding)?)(?=\d)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
  const isBid = /\b(?:bid(?:s|ding)?|bed|bet(?:s|ting)?|spit(?:s|ting)?|dollars?|bucks?|yes|yep)\b/.test(normalized);
  const amountMatch = normalized.match(/(?:\$|at\s+|bids?\s+)?(\d{1,3})/);
  return {
    normalized,
    isBid,
    amount: amountMatch ? Number(amountMatch[1]) : null
  };
}
