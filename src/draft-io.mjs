const COLUMN_ALIASES = {
  name: ["name", "player", "player name", "full name", "athlete"],
  position: ["position", "pos", "player position"],
  team: ["team", "nfl team", "pro team", "club"],
  value: ["value", "auction value", "suggested value", "price", "projected value", "avg value"]
};

export function parseCsv(text) {
  const input = String(text || "").replace(/^\uFEFF/, "");
  const parsed = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) parsed.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) parsed.push(row);
  if (!parsed.length) throw new Error("The CSV file is empty.");
  const headers = parsed.shift().map((value, index) => value.trim() || `Column ${index + 1}`);
  if (!headers.length) throw new Error("The CSV needs a header row.");
  return { headers, rows: parsed };
}

export function suggestCsvMapping(headers) {
  const normalized = headers.map(normalizeHeader);
  return Object.fromEntries(Object.entries(COLUMN_ALIASES).map(([field, aliases]) => [
    field,
    normalized.findIndex((header) => aliases.includes(header))
  ]));
}

export function playersFromMappedCsv(rows, mapping) {
  const nameIndex = validIndex(mapping?.name);
  const positionIndex = validIndex(mapping?.position);
  if (nameIndex < 0 || positionIndex < 0) throw new Error("Map both Player name and Position before importing.");
  const teamIndex = validIndex(mapping?.team);
  const valueIndex = validIndex(mapping?.value);
  const players = rows.map((row, index) => {
    const name = String(row[nameIndex] || "").trim();
    if (!name) return null;
    const position = String(row[positionIndex] || "FLEX").trim().toUpperCase() || "FLEX";
    return {
      id: `import-${slug(name)}-${index}`,
      name,
      position,
      nflTeam: teamIndex >= 0 ? String(row[teamIndex] || "FA").trim().toUpperCase() || "FA" : "FA",
      suggestedValue: valueIndex >= 0 ? Math.max(0, moneyNumber(row[valueIndex])) : 1,
      status: "available"
    };
  }).filter(Boolean);
  if (!players.length) throw new Error("No players were found in the mapped name column.");
  return players;
}

export function buildResultsPayload(state, generatedAt = Date.now()) {
  const players = new Map(state.players.map((player) => [player.id, player]));
  const teams = state.teams.map((team) => ({
    id: team.id,
    name: team.name,
    manager: team.manager,
    color: team.color,
    budgetStart: state.config.budget,
    budgetRemaining: team.budget,
    spent: state.config.budget - team.budget,
    roster: team.roster.map((spot) => {
      const player = players.get(spot.playerId) || {};
      return {
        playerId: spot.playerId,
        name: player.name || "Unknown player",
        position: player.position || "FLEX",
        nflTeam: player.nflTeam || "FA",
        suggestedValue: Number(player.suggestedValue) || 0,
        price: Number(spot.price) || 0
      };
    })
  }));
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const sales = state.sales.map((sale) => {
    const player = players.get(sale.playerId) || {};
    const team = teamsById.get(sale.teamId) || {};
    return {
      playerId: sale.playerId,
      playerName: player.name || "Unknown player",
      position: player.position || "FLEX",
      nflTeam: player.nflTeam || "FA",
      suggestedValue: Number(player.suggestedValue) || 0,
      teamId: sale.teamId,
      fantasyTeam: team.name || "Unknown team",
      manager: team.manager || "Unknown manager",
      price: Number(sale.amount) || 0,
      at: sale.at || null
    };
  });
  return {
    version: 1,
    generatedAt,
    config: {
      budget: state.config.budget,
      rosterSize: state.config.rosterSize,
      increment: state.config.increment,
      rosterRequirements: { ...(state.config.rosterRequirements || {}) }
    },
    teams,
    sales
  };
}

export function resultsToCsv(payload) {
  const rows = [["Player", "Position", "NFL Team", "Fantasy Team", "Manager", "Price", "Suggested Value", "Value Difference"]];
  for (const sale of payload.sales) {
    rows.push([
      sale.playerName,
      sale.position,
      sale.nflTeam,
      sale.fantasyTeam,
      sale.manager,
      sale.price,
      sale.suggestedValue,
      sale.suggestedValue - sale.price
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function platformResultsText(payload, platform = "espn") {
  const formats = {
    espn: {
      header: ["Player", "Position", "NFL Team", "Fantasy Team", "Manager", "Salary"],
      row: (sale) => [sale.playerName, sale.position, sale.nflTeam, sale.fantasyTeam, sale.manager, `$${sale.price}`]
    },
    yahoo: {
      header: ["Player", "NFL Team", "Position", "Fantasy Team", "Cost"],
      row: (sale) => [sale.playerName, sale.nflTeam, sale.position, sale.fantasyTeam, `$${sale.price}`]
    },
    sleeper: {
      header: ["Fantasy Team", "Manager", "Player", "Position", "NFL Team", "Auction Cost"],
      row: (sale) => [sale.fantasyTeam, sale.manager, sale.playerName, sale.position, sale.nflTeam, `$${sale.price}`]
    }
  };
  const format = formats[platform] || formats.espn;
  return [format.header, ...payload.sales.map(format.row)].map((row) => row.join("\t")).join("\n");
}

export async function encodeResultsPayload(payload) {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  if (globalThis.CompressionStream) {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return `g.${bytesToBase64Url(compressed)}`;
  }
  return `j.${bytesToBase64Url(raw)}`;
}

export async function decodeResultsPayload(encoded) {
  const [kind, body] = String(encoded || "").split(".", 2);
  if (!body || !["g", "j"].includes(kind)) throw new Error("This results link is not valid.");
  let bytes = base64UrlToBytes(body);
  if (kind === "g") {
    if (!globalThis.DecompressionStream) throw new Error("This browser cannot open compressed results links.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  if (payload?.version !== 1 || !Array.isArray(payload.teams) || !Array.isArray(payload.sales)) {
    throw new Error("This results link contains an unsupported draft format.");
  }
  return payload;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function moneyNumber(value) {
  const number = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function validIndex(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : -1;
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function slug(value) {
  return String(value || "player").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "player";
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
