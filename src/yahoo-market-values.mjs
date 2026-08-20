const MARKET_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

export function parseYahooMarketValues(source) {
  const text = String(source || "").trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.players;
    return normalizeRows(rows);
  }
  const lines = String(source).split(/\r?\n/);
  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    const teamPosition = lines[index].trim().match(/^(.+?)\s+-\s+(QB|RB|WR|TE|K|DST|DEF)$/i);
    if (!teamPosition) continue;
    const name = lines[index - 1]?.trim();
    let draftedIndex = -1;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 12); cursor += 1) {
      if (/^\d+(?:\.\d+)?%$/.test(lines[cursor].trim())) { draftedIndex = cursor; break; }
    }
    if (!name || draftedIndex < 0) continue;
    const rank = lines.slice(index + 1, draftedIndex).map((line) => Number(line.trim())).find(Number.isInteger);
    rows.push({
      name,
      nflTeam: teamPosition[1].trim().toUpperCase(),
      position: teamPosition[2].toUpperCase() === "DEF" ? "DST" : teamPosition[2].toUpperCase(),
      rank: Number(rank) || 0,
      draftedPercentage: Number.parseFloat(lines[draftedIndex]) || 0,
      averageValue: Number(lines[draftedIndex + 1]) || 0,
      projectedValue: Number(lines[draftedIndex + 2]) || 0
    });
  }
  return normalizeRows(rows);
}

export function applyYahooMarketValues(players, marketRows) {
  const rows = normalizeRows(marketRows);
  const calibration = quadraticMarketCalibration(rows);
  const directByName = new Map(rows.map((row) => [normalizedName(row.name), row]));
  const directByTeamPosition = new Map(rows.map((row) => [`${row.position}:${row.nflTeam}`, row]));
  const defenseRows = rows.filter((row) => row.position === "DST");
  let directMatches = 0;
  const enriched = players.map((player) => {
    const position = cleanPosition(player.position);
    const playerName = normalizedName(player.name);
    const direct = directByName.get(playerName)
      || (position === "DST" ? directByTeamPosition.get(`${position}:${cleanText(player.nflTeam, 12).toUpperCase()}`) : null)
      || (position === "DST" ? defenseRows.find((row) => playerName.endsWith(normalizedName(row.name))) : null);
    const suggestedValue = Math.max(1, Number(player.suggestedValue) || 1);
    if (direct) directMatches += 1;
    const marketAverage = direct
      ? direct.averageValue
      : evaluateMarketCalibration(calibration, suggestedValue);
    return {
      ...player,
      marketAverage: roundTenth(Math.max(1, marketAverage)),
      marketProjected: roundTenth(Math.max(1, direct?.projectedValue || suggestedValue)),
      marketDraftedPercentage: roundTenth(Math.max(0, direct?.draftedPercentage || 0)),
      marketSource: direct ? "yahoo-average" : "yahoo-curve"
    };
  });
  return { players: enriched, directMatches, rowCount: rows.length, calibration };
}

export function quadraticMarketCalibration(rows) {
  const valid = normalizeRows(rows).filter((row) => row.projectedValue > 0 && row.averageValue > 0);
  if (valid.length < 3) return { intercept: 0, linear: 1, quadratic: 0 };
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
  const target = [0, 0, 0];
  for (const row of valid) {
    const features = [1, row.projectedValue, row.projectedValue ** 2];
    for (let left = 0; left < 3; left += 1) {
      target[left] += features[left] * row.averageValue;
      for (let right = 0; right < 3; right += 1) matrix[left][right] += features[left] * features[right];
    }
  }
  const [intercept, linear, quadratic] = solveThreeByThree(matrix, target);
  return { intercept, linear, quadratic };
}

export function evaluateMarketCalibration(calibration, projectedValue) {
  const value = Math.max(0, Number(projectedValue) || 0);
  return Number(calibration?.intercept || 0)
    + Number(calibration?.linear || 0) * value
    + Number(calibration?.quadratic || 0) * value * value;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    name: cleanText(row?.name, 120),
    nflTeam: cleanText(row?.nflTeam, 12).toUpperCase(),
    position: cleanPosition(row?.position),
    rank: wholeNumber(row?.rank),
    draftedPercentage: boundedNumber(row?.draftedPercentage, 0, 100),
    averageValue: boundedNumber(row?.averageValue, 0, 10_000),
    projectedValue: boundedNumber(row?.projectedValue, 0, 10_000)
  })).filter((row) => row.name && MARKET_POSITIONS.has(row.position) && row.averageValue > 0);
}

function solveThreeByThree(matrix, target) {
  const values = matrix.map((row, index) => [...row, target[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(values[row][column]) > Math.abs(values[pivot][column])) pivot = row;
    }
    [values[column], values[pivot]] = [values[pivot], values[column]];
    const divisor = values[column][column];
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-12) return [0, 1, 0];
    for (let cursor = column; cursor < 4; cursor += 1) values[column][cursor] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = values[row][column];
      for (let cursor = column; cursor < 4; cursor += 1) values[row][cursor] -= factor * values[column][cursor];
    }
  }
  return values.map((row) => row[3]);
}

function normalizedName(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]/g, "");
}
function cleanPosition(value) { const position = cleanText(value, 8).toUpperCase(); return position === "DEF" ? "DST" : MARKET_POSITIONS.has(position) ? position : ""; }
function cleanText(value, maximum) { return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maximum); }
function wholeNumber(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0; }
function boundedNumber(value, minimum, maximum) { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : minimum; }
function roundTenth(value) { return Math.round(Number(value) * 10) / 10; }
