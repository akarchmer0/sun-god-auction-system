import { parseCsv } from "./draft-io.mjs";

export const AUTODRAFT_VALUE_PROFILE_SOURCES = Object.freeze([
  Object.freeze({ id: "alex-gerszten", manager: "Alex Gerszten", fileName: "Alex_Gerszten_Values.csv" }),
  Object.freeze({ id: "yuvi-bermel", manager: "Yuvi Bermel", fileName: "Yuvi_Bermel_Values.csv" })
]);

export function buildAutodraftValueProfile({ id, manager, fileName = "", csvText, basePlayers }) {
  const parsed = parseCsv(csvText);
  const headers = parsed.headers.map((header) => String(header || "").trim().toLowerCase());
  const playerIndex = headers.indexOf("player");
  const valueIndex = headers.indexOf("value");
  if (playerIndex < 0 || valueIndex < 0) throw new Error(`${fileName || id} must contain player and value columns.`);
  if (!Array.isArray(basePlayers) || !basePlayers.length) throw new Error("The base player universe is empty.");

  const baseByName = uniquePlayerMap(basePlayers.map((player) => [normalizePlayerName(player?.name), player]), "base player universe");
  const customEntries = parsed.rows.map((row, index) => {
    const name = String(row[playerIndex] || "").trim();
    const value = Number(row[valueIndex]);
    if (!name) throw new Error(`${fileName || id} row ${index + 2} has no player name.`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${fileName || id} row ${index + 2} has an invalid value.`);
    return [normalizePlayerName(name), { name, value: Math.round(value) }];
  });
  const customByName = uniquePlayerMap(customEntries, fileName || id);
  const values = {};
  let matchedCount = 0;
  let fallbackCount = 0;
  for (const player of basePlayers) {
    const custom = customByName.get(normalizePlayerName(player.name));
    if (custom) matchedCount += 1;
    else fallbackCount += 1;
    values[player.id] = custom ? custom.value : Math.max(0, Math.round(Number(player.suggestedValue) || 0));
  }
  const excludedCustomPlayers = [...customByName.entries()]
    .filter(([key]) => !baseByName.has(key))
    .map(([, player]) => player.name);

  return {
    id: cleanId(id),
    manager: String(manager || "").trim(),
    managerKey: normalizeManagerName(manager),
    fileName: String(fileName || ""),
    values,
    basePlayerCount: basePlayers.length,
    sourceRowCount: customByName.size,
    matchedCount,
    fallbackCount,
    excludedCustomPlayers
  };
}

export function normalizeManagerName(value) {
  return normalizeName(value).replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]/g, "");
}

export function normalizePlayerName(value) {
  return normalizeName(value).replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]/g, "");
}

function uniquePlayerMap(entries, label) {
  const values = new Map();
  for (const [key, value] of entries) {
    if (!key) throw new Error(`${label} contains an empty player name.`);
    if (values.has(key)) throw new Error(`${label} contains a duplicate player: ${value?.name || key}.`);
    values.set(key, value);
  }
  return values;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function cleanId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9_-]{1,80}$/.test(id)) throw new Error("An autodraft value profile ID is invalid.");
  return id;
}
