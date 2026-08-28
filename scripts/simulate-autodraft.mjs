import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTeams } from "../src/data.mjs";
import { fantasyProsPlayersFromCsv } from "../src/fantasy-pros-data.mjs";
import { parseCsv, playersFromMappedCsv, suggestCsvMapping, buildResultsPayload } from "../src/draft-io.mjs";
import { advanceCountdown, AUTO_ROSTER_REQUIREMENTS, canTeamRosterPlayer, createDraft, maxBidForTeam, nominatePlayer, openAuction, placeBid, ROSTER_POSITIONS } from "../src/domain.mjs";
import {
  buildAutoIntentContext,
  calculateAutoBidCeiling,
  chooseAutoBid,
  chooseAutoNomination,
  localAutoIntents,
  normalizeAutoIntents
} from "../src/autodraft.mjs";
import { OpenAIAutodraftService } from "../src/openai-autodraft-service.mjs";
import { applyYahooMarketValues, parseYahooMarketValues } from "../src/yahoo-market-values.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fantasyProsPlayers = fantasyProsPlayersFromCsv(await readFile(join(ROOT, "data", "player_values.csv"), "utf8"));
const SAVED_DRAFT_PATH = join(homedir(), "Library", "Application Support", "Sun God Auctioneer", "current.json");
const STANDARD_REQUIREMENTS = AUTO_ROSTER_REQUIREMENTS;
const DEFAULT_OUTPUT = resolve(ROOT, "artifacts/autodraft-simulation.html");
const HELP = `Sun God autodraft simulation

Usage:
  ./simulate-autodraft.command [options]

  With npm installed: npm run simulate:autodraft -- [options]

By default, the script uses data/player_values.csv and the league
setup from Sun God's current durable draft snapshot. Every player is reset to
available and every team is converted to auto draft before the simulation starts.

Options:
  --players <csv>          Override the saved player pool with a CSV
  --yahoo-values <file>    Optionally add Yahoo market context from text or JSON
  --draft-state <json>     Override the saved league configuration
  --output <html>          Report path (default: artifacts/autodraft-simulation.html)
  --teams <count>          Number of teams (default: 12)
  --budget <dollars>       Override the budget per team
  --roster-size <count>    Override players per team
  --increment <dollars>    Override the legal bid increment
  --requirements <list>   Example: QB=2,RB=4,WR=5,TE=2,FLEX=0,K=1,DST=1
  --seed <text>            Stable simulation seed (default: fantasypros-1)
  --mode <auto|ai|local>   Auto uses OpenAI when OPENAI_API_KEY exists (default: auto)
  --model <name>           Override OPENAI_AUTODRAFT_MODEL
  --max-lots <count>       Safety limit (default: 5000)
  --help                   Show this message
`;

export async function simulateAutodraft({
  players,
  teams,
  budget,
  rosterSize,
  increment = 1,
  rosterRequirements = STANDARD_REQUIREMENTS,
  seed = "fantasypros-1",
  sourceLabel = "Player pool",
  intentService = null,
  maxValueStrategy = null,
  nominationStrategy = null,
  maxLots = 5_000,
  onLot = null
}) {
  validateSimulationInput({ players, teams, budget, rosterSize, increment, rosterRequirements });
  let state = createDraft({
    players: players.map((player) => ({ ...player, status: "available" })),
    teams: teams.map((team) => ({ ...team, controller: { type: "auto", strategy: "balanced", aggressiveness: 1 }, roster: [] })),
    budget,
    rosterSize,
    increment,
    rosterRequirements,
    nominationOrder: teams.map((team) => team.id)
  });
  const lots = [];
  const passedSinceSale = new Set();

  while (state.teams.some((team) => team.roster.length < rosterSize)) {
    if (lots.length >= maxLots) throw new Error(`Simulation stopped after ${maxLots} lots without filling every team.`);
    if (availablePlayerCount(state) < openRosterSlotCount(state)) throw new Error("The player pool ran out before every roster could be filled.");

    const nomination = findSimulationNomination(state, passedSinceSale, nominationStrategy);
    if (!nomination && passedSinceSale.size) {
      throw new Error("Every currently rosterable player completed a no-bid pass cycle. Adjust the player pool, requirements, or intent strategy.");
    }
    if (!nomination) throw new Error("No incomplete team can legally nominate a remaining player.");

    state = { ...state, nomination: { ...state.nomination, currentIndex: nomination.nominationIndex } };
    state = nominatePlayer(state, nomination.playerId);
    const player = state.players.find((item) => item.id === nomination.playerId);
    const fallback = localAutoIntents(state);
    const resolved = await resolveIntents(state, fallback, intentService);
    state = {
      ...state,
      auction: { ...state.auction, autoIntents: resolved.intents, autoIntentStatus: "ready" }
    };
    const ceilingOverrides = {};
    const maximums = Object.fromEntries(state.teams.map((team) => {
      const baselineMaximum = calculateAutoBidCeiling(state, team.id, player.id, resolved.intents[team.id]?.intent);
      const proposed = maxValueStrategy?.({ state, team, player, baselineMaximum, decision: resolved.intents[team.id] });
      const hasOverride = proposed !== null && proposed !== undefined && Number.isFinite(Number(proposed));
      const maximum = hasOverride
        ? Math.min(maxBidForTeam(state, team.id), Math.max(team.id === state.auction.nominatorTeamId ? 1 : 0, Math.round(Number(proposed))))
        : baselineMaximum;
      if (hasOverride) ceilingOverrides[team.id] = maximum;
      return [team.id, maximum];
    }));

    state = openAuction(state);
    const bids = [];
    const bidSafetyLimit = Math.max(100, state.teams.length * budget * 2);
    while (true) {
      const decision = chooseAutoBid(state, ceilingOverrides);
      if (!decision) break;
      bids.push({ ...decision });
      state = placeBid(state, decision.teamId, decision.amount);
      if (bids.length > bidSafetyLimit) throw new Error(`Bidding did not settle for ${player.name}.`);
    }

    const highBidderId = state.auction.highBidderId;
    const finalAmount = state.auction.amount;
    if (highBidderId) {
      state = advanceCountdown(advanceCountdown(advanceCountdown(state)));
      passedSinceSale.clear();
    } else {
      state = advanceCountdown(state);
      passedSinceSale.add(player.id);
    }

    const lot = {
      number: lots.length + 1,
      player: { ...player },
      nominatorTeamId: nomination.team.id,
      provider: resolved.provider,
      model: resolved.model,
      intents: state.teams.map((team) => ({
        teamId: team.id,
        teamName: team.name,
        manager: team.manager,
        ...resolved.intents[team.id],
        maximum: maximums[team.id]
      })),
      bids,
      winnerTeamId: highBidderId,
      amount: highBidderId ? finalAmount : null,
      outcome: highBidderId ? "sold" : "passed"
    };
    lots.push(lot);
    onLot?.(lot, state);
  }

  const generatedAt = Date.now();
  return { seed, sourceLabel, generatedAt, state, lots, results: buildResultsPayload(state, generatedAt) };
}

export function renderSimulationHtml(simulation, { title = "Autodraft Simulation" } = {}) {
  const { results, lots, generatedAt, seed, sourceLabel } = simulation;
  const teamMap = new Map(results.teams.map((team) => [team.id, team]));
  const totalSpent = results.teams.reduce((sum, team) => sum + team.spent, 0);
  const averagePrice = results.sales.length ? (totalSpent / results.sales.length).toFixed(1) : "0.0";
  const providerCounts = countBy(lots, (lot) => lot.provider || "local");
  const providerSummary = Object.entries(providerCounts).map(([provider, count]) => `${provider}: ${count}`).join(" · ");
  const topSale = [...results.sales].sort((left, right) => right.price - left.price)[0];

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>${reportCss()}</style></head>
<body>
  <header class="topbar"><div class="brand"><span>☀</span><strong>SUN GOD</strong><small>AUTODRAFT LAB</small></div><button onclick="window.print()">Print report</button></header>
  <main>
    <section class="hero"><p class="eyebrow">SIMULATION COMPLETE · ${escapeHtml(formatDate(generatedAt))}</p><h1>${escapeHtml(title)}</h1><p>Every roster was filled through sequential nominations and live one-increment bidding against frozen private maximums.</p>
      <div class="metrics">${metric(results.teams.length, "Teams")}${metric(results.sales.length, "Players drafted")}${metric(lots.length, "Lots run")}${metric(`$${totalSpent}`, "Total spent")}${metric(`$${averagePrice}`, "Average price")}</div>
    </section>
    <section class="facts">
      <div><span>SOURCE</span><strong>${escapeHtml(sourceLabel)}</strong></div><div><span>FORMAT</span><strong>$${results.config.budget} · ${results.config.rosterSize} spots · $${results.config.increment} increment</strong></div>
      <div><span>SEED</span><strong>${escapeHtml(seed)}</strong></div><div><span>INTENT PROVIDERS</span><strong>${escapeHtml(providerSummary || "local")}</strong></div><div><span>TOP SALE</span><strong>${topSale ? `${escapeHtml(topSale.playerName)} · $${topSale.price}` : "None"}</strong></div>
    </section>
    <section class="section"><div class="section-title"><p class="eyebrow">FINAL ROSTERS</p><h2>Drafted teams</h2></div><div class="team-grid">${results.teams.map(renderTeam).join("")}</div></section>
    <section class="section"><div class="section-title"><p class="eyebrow">AUDIT TRAIL</p><h2>Sequential auction ledger</h2><p>Expand a lot to inspect each autodrafter’s intent and sampled maximum.</p></div><div class="ledger">${lots.map((lot) => renderLot(lot, teamMap)).join("")}</div></section>
  </main>
</body></html>`;
}

export function parseSimulationArgs(argv) {
  const options = {
    playersPath: null,
    yahooValuesPath: undefined,
    draftStatePath: SAVED_DRAFT_PATH,
    outputPath: DEFAULT_OUTPUT,
    teamCount: 12,
    budget: null,
    rosterSize: null,
    increment: null,
    rosterRequirements: null,
    seed: "fantasypros-1",
    mode: "auto",
    model: null,
    maxLots: 5_000,
    help: false
  };
  const valueOptions = new Set(["--players", "--yahoo-values", "--draft-state", "--output", "--teams", "--budget", "--roster-size", "--increment", "--requirements", "--seed", "--mode", "--model", "--max-lots"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") { options.help = true; continue; }
    if (flag === "--no-market-values") { options.yahooValuesPath = false; continue; }
    if (!valueOptions.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    index += 1;
    if (flag === "--players") options.playersPath = resolve(value);
    else if (flag === "--yahoo-values") options.yahooValuesPath = resolve(value);
    else if (flag === "--draft-state") options.draftStatePath = resolve(value);
    else if (flag === "--output") options.outputPath = resolve(value);
    else if (flag === "--teams") options.teamCount = positiveInteger(value, flag);
    else if (flag === "--budget") options.budget = positiveInteger(value, flag);
    else if (flag === "--roster-size") options.rosterSize = positiveInteger(value, flag);
    else if (flag === "--increment") options.increment = positiveInteger(value, flag);
    else if (flag === "--requirements") options.rosterRequirements = parseRequirements(value);
    else if (flag === "--seed") options.seed = String(value).trim() || "fantasypros-1";
    else if (flag === "--mode") options.mode = String(value).toLowerCase();
    else if (flag === "--model") options.model = String(value).trim();
    else if (flag === "--max-lots") options.maxLots = positiveInteger(value, flag);
  }
  if (!["auto", "ai", "local"].includes(options.mode)) throw new Error("--mode must be auto, ai, or local.");
  return options;
}

async function main() {
  try {
    loadLocalEnv();
    const options = parseSimulationArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(HELP); return; }
    const source = await loadSimulationSource(options);
    const intentService = createIntentService(options);
    process.stdout.write(`Simulating ${source.teams.length} teams × ${source.rosterSize} players from ${source.sourceLabel}...\n`);
    const simulation = await simulateAutodraft({
      ...source,
      seed: options.seed,
      intentService,
      maxLots: options.maxLots,
      onLot: (lot) => {
        const winner = source.teams.find((team) => team.id === lot.winnerTeamId)?.name;
        process.stdout.write(`Lot ${lot.number}: ${lot.outcome === "sold" ? `${lot.player.name} → ${winner} for $${lot.amount}` : `${lot.player.name} passed`}\n`);
      }
    });
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, renderSimulationHtml(simulation, { title: "FantasyPros Autodraft Simulation" }), "utf8");
    process.stdout.write(`Complete: ${simulation.results.sales.length} players drafted across ${simulation.lots.length} lots.\nReport: ${options.outputPath}\n`);
  } catch (error) {
    process.stderr.write(`Autodraft simulation failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

async function resolveIntents(state, fallback, intentService) {
  if (!intentService) return { intents: fallback, provider: "local", model: null };
  const response = await intentService.createIntents({
    context: buildAutoIntentContext(state),
    fallbackDecisions: Object.entries(fallback).map(([teamId, decision]) => ({ teamId, intent: decision.intent, reason: decision.reason }))
  });
  return {
    intents: normalizeAutoIntents(state, response.decisions, { provider: response.provider, model: response.model }),
    provider: response.provider || "local",
    model: response.model || null
  };
}

function findSimulationNomination(state, excludedPlayerIds, nominationStrategy = null) {
  const order = state.nomination.order;
  const start = state.nomination.currentIndex;
  for (let offset = 0; offset < order.length; offset += 1) {
    const nominationIndex = (start + offset) % order.length;
    const team = state.teams.find((item) => item.id === order[nominationIndex]);
    if (!team || team.roster.length >= state.config.rosterSize) continue;
    const selectionState = excludedPlayerIds.size
      ? { ...state, players: state.players.map((player) => excludedPlayerIds.has(player.id) ? { ...player, status: "sold" } : player) }
      : state;
    const proposedPlayerId = nominationStrategy?.({ state: selectionState, team }) ?? null;
    const proposedPlayer = selectionState.players.find((player) => player.id === proposedPlayerId);
    const playerId = proposedPlayer?.status === "available" && canTeamRosterPlayer(selectionState, team.id, proposedPlayerId)
      ? proposedPlayerId
      : chooseAutoNomination(selectionState, team.id);
    if (playerId) return { team, playerId, nominationIndex };
  }
  return null;
}

export async function loadSimulationSource(options = {}) {
  let saved = null;
  const draftStatePath = options.draftStatePath || SAVED_DRAFT_PATH;
  if (existsSync(draftStatePath)) {
    const parsed = JSON.parse(await readFile(draftStatePath, "utf8"));
    saved = parsed.state || parsed;
  }
  let players;
  let sourceLabel;
  if (options.playersPath) {
    const { headers, rows } = parseCsv(await readFile(options.playersPath, "utf8"));
    players = playersFromMappedCsv(rows, suggestCsvMapping(headers));
    sourceLabel = options.playersPath;
  } else {
    players = fantasyProsPlayers.map((player) => ({ ...player }));
    sourceLabel = "data/player_values.csv base snapshot";
  }
  players = players.map((player) => ({
    ...player,
    status: "available"
  }));
  const yahooValuesPath = options.yahooValuesPath === false
    ? null
    : options.yahooValuesPath || null;
  let marketCalibration = null;
  if (yahooValuesPath) {
    const marketRows = parseYahooMarketValues(await readFile(yahooValuesPath, "utf8"));
    const market = applyYahooMarketValues(players, marketRows);
    players = market.players;
    marketCalibration = market.calibration;
    sourceLabel += ` · Yahoo Avg $ market (${market.directMatches}/${market.rowCount} direct matches)`;
  }

  const teamCount = options.teamCount || saved?.teams?.length || 3;
  const budget = options.budget || saved?.config?.budget || 200;
  const rosterSize = options.rosterSize || saved?.config?.rosterSize || 8;
  const increment = options.increment || saved?.config?.increment || 1;
  const savedRequirements = normalizeRequirements(saved?.config?.rosterRequirements);
  const rosterRequirements = options.rosterRequirements || (sumRequirements(savedRequirements) ? savedRequirements : { ...STANDARD_REQUIREMENTS });
  const baseTeams = saved?.teams?.length === teamCount ? saved.teams : makeTeams(teamCount, budget);
  const safeSeed = String(options.seed).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "simulation";
  const teams = baseTeams.slice(0, teamCount).map((team, index) => ({
    ...team,
    id: `${safeSeed}-team-${index + 1}`,
    budget,
    roster: [],
    controller: { type: "auto", strategy: "balanced", aggressiveness: 1 }
  }));
  return { players, teams, budget, rosterSize, increment, rosterRequirements, sourceLabel, marketCalibration };
}

function createIntentService(options) {
  if (options.mode === "local") return null;
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey && options.mode === "ai") throw new Error("--mode ai requires OPENAI_API_KEY in the environment or project .env file.");
  if (!apiKey) return null;
  return new OpenAIAutodraftService({ apiKey, model: options.model || process.env.OPENAI_AUTODRAFT_MODEL });
}

function validateSimulationInput({ players, teams, budget, rosterSize, increment, rosterRequirements }) {
  if (!Array.isArray(players) || !players.length) throw new Error("The simulation needs a player pool.");
  if (!Array.isArray(teams) || teams.length < 2 || teams.length > 16) throw new Error("The simulation needs 2–16 teams.");
  if (!Number.isInteger(budget) || budget < 20) throw new Error("Budget must be a whole number of at least 20.");
  if (!Number.isInteger(rosterSize) || rosterSize < 1 || rosterSize > 50) throw new Error("Roster size must be 1–50.");
  if (!Number.isInteger(increment) || increment < 1) throw new Error("Bid increment must be a positive whole number.");
  if (sumRequirements(rosterRequirements) > rosterSize) throw new Error("Position requirements exceed the configured roster size.");
  const totalSlots = teams.length * rosterSize;
  if (players.length < totalSlots) throw new Error(`The simulation needs at least ${totalSlots} players; only ${players.length} were supplied.`);
  const counts = countBy(players, (player) => String(player.position || "").toUpperCase());
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const needed = teams.length * Number(rosterRequirements[position] || 0);
    if ((counts[position] || 0) < needed) throw new Error(`The player pool needs at least ${needed} ${position} players.`);
  }
  const flexNeeded = teams.length * (["RB", "WR", "TE"].reduce((sum, position) => sum + Number(rosterRequirements[position] || 0), 0) + Number(rosterRequirements.FLEX || 0));
  const flexAvailable = ["RB", "WR", "TE"].reduce((sum, position) => sum + (counts[position] || 0), 0);
  if (flexAvailable < flexNeeded) throw new Error(`The player pool needs at least ${flexNeeded} total RB/WR/TE players for base and FLEX slots.`);
}

function parseRequirements(value) {
  const requirements = Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, 0]));
  for (const entry of String(value).split(",").filter(Boolean)) {
    const [rawPosition, rawCount] = entry.split(/[=:]/);
    const position = String(rawPosition || "").trim().toUpperCase();
    if (!ROSTER_POSITIONS.includes(position)) throw new Error(`Unsupported requirement position: ${position || entry}`);
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 0) throw new Error(`Requirement ${entry} needs a non-negative whole number.`);
    requirements[position] = count;
  }
  return requirements;
}

function normalizeRequirements(value = {}) {
  return Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Math.max(0, Number(value[position]) || 0)]));
}

function sumRequirements(requirements) {
  return Object.values(requirements || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} needs a positive whole number.`);
  return number;
}

function loadLocalEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(OPENAI_API_KEY|OPENAI_AUTODRAFT_MODEL)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").trim();
    if (value) process.env[match[1]] = value;
  }
}

function openRosterSlotCount(state) {
  return state.teams.reduce((sum, team) => sum + Math.max(0, state.config.rosterSize - team.roster.length), 0);
}

function availablePlayerCount(state) {
  return state.players.filter((player) => player.status === "available").length;
}

function renderTeam(team) {
  const roster = [...team.roster].sort((left, right) => positionOrder(left.position) - positionOrder(right.position) || right.price - left.price);
  return `<article class="team-card" style="--team:${escapeHtml(team.color)}"><header><i></i><div><h3>${escapeHtml(team.name)}</h3><p>${escapeHtml(team.manager)}</p></div><strong>$${team.budgetRemaining}<small>LEFT</small></strong></header><div class="spend"><span><i style="width:${Math.min(100, team.spent / Math.max(1, team.budgetStart) * 100)}%"></i></span><small>$${team.spent} spent of $${team.budgetStart}</small></div><table><thead><tr><th>Pos</th><th>Player</th><th>Price</th><th>Value</th><th>±</th></tr></thead><tbody>${roster.map((player) => `<tr><td><b>${escapeHtml(player.position)}</b></td><td>${escapeHtml(player.name)} <small>${escapeHtml(player.nflTeam)}</small></td><td>$${player.price}</td><td>$${player.suggestedValue}</td><td class="${player.price <= player.suggestedValue ? "good" : "bad"}">${signed(player.suggestedValue - player.price)}</td></tr>`).join("")}</tbody></table></article>`;
}

function renderLot(lot, teamMap) {
  const winner = teamMap.get(lot.winnerTeamId);
  const result = lot.outcome === "sold" ? `${escapeHtml(winner?.name || "Unknown team")} · $${lot.amount}` : "No sale";
  return `<details class="lot"><summary><span>${String(lot.number).padStart(3, "0")}</span><b>${escapeHtml(lot.player.position)}</b><strong>${escapeHtml(lot.player.name)}</strong><small>Suggested $${lot.player.suggestedValue}</small><em>${result}</em></summary><div class="lot-body"><p>Nominated by ${escapeHtml(teamMap.get(lot.nominatorTeamId)?.name || "Unknown team")} · ${lot.bids.length} bids · ${escapeHtml(lot.provider || "local")}${lot.model ? ` (${escapeHtml(lot.model)})` : ""}</p><div class="intent-grid">${lot.intents.map((decision) => `<div><span>${escapeHtml(decision.teamName)}</span><b class="intent ${escapeHtml(decision.intent)}">${escapeHtml(decision.intent)}</b><strong>Max $${decision.maximum}</strong><small>${escapeHtml(String(decision.reason || "").replaceAll("_", " "))}</small></div>`).join("")}</div></div></details>`;
}

function metric(value, label) {
  return `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function signed(value) { return `${value >= 0 ? "+" : "−"}$${Math.abs(value)}`; }
function positionOrder(position) { const index = ROSTER_POSITIONS.indexOf(position); return index < 0 ? 99 : index; }
function formatDate(value) { return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(new Date(value)); }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

function reportCss() {
  return `:root{--ink:#18130d;--paper:#f8efd9;--sand:#e7d9bb;--gold:#d49a1f;--line:#2a2117;--muted:#746856;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--sand)}*{box-sizing:border-box}body{margin:0}.topbar{height:68px;padding:0 4vw;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);background:rgba(248,239,217,.96);position:sticky;top:0;z-index:4}.brand{display:flex;align-items:center;gap:9px}.brand>span{width:38px;height:38px;display:grid;place-items:center;border:1px solid;border-radius:50%;background:var(--gold);font-size:21px}.brand strong{font-size:14px}.brand small{font:700 7px/1 monospace;letter-spacing:.12em;color:var(--muted)}button{border:1px solid var(--line);background:var(--ink);color:var(--paper);padding:9px 13px;border-radius:4px;font-weight:800;cursor:pointer}main{width:min(1320px,92vw);margin:auto;padding:54px 0 90px}.eyebrow{margin:0;color:var(--muted);font:700 9px/1.2 monospace;letter-spacing:.14em}.hero h1{margin:12px 0 9px;font-size:clamp(48px,8vw,92px);line-height:.9;letter-spacing:-.065em}.hero>p:last-of-type{color:var(--muted);max-width:720px;line-height:1.55}.metrics{display:grid;grid-template-columns:repeat(5,1fr);margin-top:34px;border:1px solid;background:var(--paper)}.metrics div{padding:18px;border-right:1px solid}.metrics div:last-child{border:0}.metrics strong,.metrics span{display:block}.metrics strong{font-size:27px}.metrics span{margin-top:5px;color:var(--muted);font:700 7px monospace;text-transform:uppercase}.facts{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid;border-top:0;background:#eddfc1}.facts div{padding:16px;border-right:1px solid}.facts div:last-child{border:0}.facts span,.facts strong{display:block}.facts span{font:700 7px monospace;letter-spacing:.1em;color:var(--muted)}.facts strong{margin-top:8px;font-size:11px}.section{margin-top:66px}.section-title h2{font-size:31px;letter-spacing:-.04em;margin:7px 0}.section-title>p:last-child{color:var(--muted);font-size:11px}.team-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:20px}.team-card{border:1px solid;background:var(--paper);box-shadow:6px 6px 0 color-mix(in srgb,var(--team),transparent 35%)}.team-card header{min-height:68px;display:grid;grid-template-columns:8px 1fr auto;gap:12px;align-items:center;padding:12px 15px;border-bottom:1px solid}.team-card header>i{width:8px;height:37px;background:var(--team)}h3{font-size:16px;margin:0}.team-card header p{font-size:9px;color:var(--muted);margin:4px 0}.team-card header>strong{text-align:right;font:800 18px monospace}.team-card header>strong small{display:block;font-size:6px;letter-spacing:.12em}.spend{padding:8px 14px;border-bottom:1px solid #c7b99c}.spend>span{display:block;height:4px;background:#d8caac}.spend>span i{height:100%;display:block;background:var(--team)}.spend small{font:600 7px monospace;color:var(--muted)}table{width:100%;border-collapse:collapse;font-size:10px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #d6c8aa}th{font:700 7px monospace;color:var(--muted);text-transform:uppercase}td:nth-last-child(-n+3),th:nth-last-child(-n+3){text-align:right}td small{color:var(--muted);font-size:7px}.good{color:#236d46}.bad{color:#9f3a25}.ledger{margin-top:20px;border-top:1px solid}.lot{background:var(--paper);border:1px solid;border-top:0}.lot summary{display:grid;grid-template-columns:40px 34px minmax(180px,1fr) 120px 180px;align-items:center;gap:10px;padding:13px 15px;cursor:pointer;list-style:none}.lot summary::-webkit-details-marker{display:none}.lot summary>span,.lot summary>b{font:700 8px monospace;color:var(--muted)}.lot summary>strong{font-size:11px}.lot summary>small{font-size:9px;color:var(--muted)}.lot summary>em{text-align:right;font-style:normal;font-size:10px;font-weight:800}.lot-body{padding:0 15px 15px;border-top:1px solid #d6c8aa}.lot-body>p{font-size:9px;color:var(--muted)}.intent-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px}.intent-grid>div{padding:10px;border:1px solid #bcae91;background:#fff8e8}.intent-grid span,.intent-grid strong,.intent-grid small{display:block}.intent-grid span{font-size:9px;font-weight:800}.intent-grid strong{margin-top:6px;font:700 11px monospace}.intent-grid small{margin-top:4px;color:var(--muted);font-size:7px}.intent{display:inline-block;margin-top:6px;padding:3px 5px;border:1px solid;border-radius:3px;font:700 7px monospace;text-transform:uppercase}.intent.target{background:#f1c768}.intent.value{background:#b7d9bc}.intent.discount{background:#c8d8e9}.intent.pass{background:#ddd5c4}@media(max-width:850px){.metrics{grid-template-columns:repeat(2,1fr)}.facts,.team-grid{grid-template-columns:1fr}.facts div{border-right:0;border-bottom:1px solid}.lot summary{grid-template-columns:34px 30px 1fr}.lot summary>small{display:none}.lot summary>em{grid-column:3;text-align:left}.intent-grid{grid-template-columns:1fr}}@media print{.topbar{display:none}body{background:white}main{width:100%;padding:0}.team-card,.lot{break-inside:avoid}.lot:not([open]) .lot-body{display:block}.team-grid{gap:7px}}`;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
