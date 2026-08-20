import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canTeamRosterPlayer } from "../src/domain.mjs";
import { loadSimulationSource, simulateAutodraft } from "./simulate-autodraft.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_OUTPUT = resolve(ROOT, "artifacts/evolved-autodraft-strategy.json");
const DEFAULT_REPORT = resolve(ROOT, "artifacts/evolved-autodraft-report.html");
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
export const POLICY_PARAMETERS = Object.freeze([
  parameter("bidBaseMultiplier", "Bid · base value multiplier", 0.30, 1.60, 0.95),
  parameter("bidEliteSlope", "Bid · elite-value slope", -0.50, 1.50, 0.15),
  ...POSITIONS.map((position) => parameter(`bid${position}Adjustment`, `Bid · ${position} adjustment`, -0.60, 0.60, 0)),
  parameter("bidRequiredNeedBonus", "Bid · required-position bonus", 0, 1.00, 0.20),
  parameter("bidFlexNeedBonus", "Bid · FLEX-need bonus", 0, 0.70, 0.10),
  parameter("bidScarcityBonus", "Bid · scarcity bonus", -0.50, 1.00, 0.10),
  parameter("bidBudgetFlex", "Bid · budget flexibility", -1.00, 1.00, 0.10),
  parameter("bidMarketGapWeight", "Bid · Yahoo market-gap weight", -1.00, 1.00, 0),
  parameter("nomValueWeight", "Nomination · suggested-value weight", 0.20, 2.00, 1.00),
  parameter("nomEliteWeight", "Nomination · elite-value weight", -0.50, 2.00, 0.20),
  parameter("nomNeedWeight", "Nomination · roster-need weight", -0.50, 2.00, 0.30),
  parameter("nomScarcityWeight", "Nomination · scarcity weight", -1.00, 1.00, 0.10),
  parameter("nomMarketWeight", "Nomination · Yahoo market-gap weight", -1.00, 1.00, 0),
  ...POSITIONS.map((position) => parameter(`nom${position}Adjustment`, `Nomination · ${position} adjustment`, -20, 20, 0))
]);
const HELP = `Sun God evolutionary autodraft trainer

Usage:
  ./evolve-autodraft.command [options]

The genome is a compact contextual policy. It turns suggested value, elite value,
position, roster need, scarcity, and budget flexibility into a maximum bid. A
separate parameter set controls nominations. One controlled team uses the policy
while every opponent uses the normal local autodrafter. Fitness is the average
sum of suggested values plus a tunable share of squared value:
sum(value) + L2 weight × sum(value²) / value scale.

Options:
  --generations <count>       Generations to run (default: 25)
  --population <count>        Candidate strategies per generation (default: 28)
  --evaluations <count>       Seats evaluated per candidate (default: 3)
  --elite <count>             Unchanged winners retained (default: 4)
  --mutation-rate <decimal>   Chance to mutate each policy parameter (default: 0.20)
  --mutation-scale <decimal>  Mutation size relative to parameter range (default: 0.12)
  --l2-weight <decimal>       Strength of the elite-player reward (default: 0.50)
  --value-scale <number>      Scale applied to squared value (default: 50)
  --seed <text>               Reproducible search seed (default: evolution-1)
  --output <json>             Best strategy JSON path
  --report <html>             Training report path
  --players <csv>             Override the bundled FantasyPros player pool
  --yahoo-values <file>       Optionally add Yahoo market context
  --draft-state <json>        Override the saved league configuration
  --teams <count>             Number of teams (default: 12)
  --budget <dollars>          Override budget per team
  --roster-size <count>       Override players per team
  --increment <dollars>       Override bid increment
  --requirements <list>      Example: QB=1,RB=2,WR=3,TE=1,FLEX=1,K=1,DST=1
  --help                      Show this message
`;

export async function evolveAutodraftStrategy({
  players,
  teams,
  budget,
  rosterSize,
  increment,
  rosterRequirements,
  sourceLabel = "Player pool",
  generations = 25,
  populationSize = 28,
  evaluations = 3,
  eliteCount = 4,
  mutationRate = 0.20,
  mutationScale = 0.12,
  l2Weight = 0.50,
  valueScale = 50,
  seed = "evolution-1",
  onGeneration = null
}) {
  const random = seededRandom(seed);
  const seatCount = Math.max(1, Math.min(teams.length, evaluations));
  let population = initialPopulation({ populationSize, random });
  const history = [];
  let baselineFitness = null;
  let best = null;

  for (let generation = 0; generation < generations; generation += 1) {
    const evaluated = [];
    for (const vector of population) {
      const evaluation = await evaluatePolicy({
        vector, players, teams, budget, rosterSize, increment, rosterRequirements,
        sourceLabel, seatCount, l2Weight, valueScale, seed: `${seed}-g${generation}`
      });
      evaluated.push({ vector, ...evaluation });
    }
    if (generation === 0) baselineFitness = evaluated[0].fitness;
    evaluated.sort((left, right) => right.fitness - left.fitness);
    if (!best || evaluated[0].fitness > best.fitness) best = cloneCandidate(evaluated[0]);
    const mean = evaluated.reduce((sum, candidate) => sum + candidate.fitness, 0) / evaluated.length;
    const entry = {
      generation: generation + 1,
      bestFitness: evaluated[0].fitness,
      allTimeBestFitness: best.fitness,
      meanFitness: mean
    };
    history.push(entry);
    onGeneration?.(entry);
    if (generation + 1 === generations) break;
    population = nextPopulation({ evaluated, populationSize, eliteCount, mutationRate, mutationScale, random });
  }

  const finalEvaluation = await evaluatePolicy({
    vector: best.vector, players, teams, budget, rosterSize, increment, rosterRequirements,
    sourceLabel, seatCount, l2Weight, valueScale, seed: `${seed}-final`, keepSimulation: true
  });
  return {
    seed,
    objective: `mean(sum(value) + ${l2Weight} * sum(value^2) / ${valueScale})`,
    reward: { l2Weight, valueScale },
    generations,
    populationSize,
    evaluations: seatCount,
    baselineFitness,
    fitness: finalEvaluation.fitness,
    seatScores: finalEvaluation.seatScores,
    history,
    vector: best.vector,
    policy: policyFromVector(best.vector),
    exampleSimulation: finalEvaluation.simulation,
    exampleSimulations: finalEvaluation.simulations
  };
}

export async function evaluatePolicy({
  vector, players, teams, budget, rosterSize, increment, rosterRequirements,
  sourceLabel, seatCount, seed, l2Weight = 0.50, valueScale = 50, keepSimulation = false
}) {
  const policy = policyFromVector(vector);
  const initialPositionCounts = positionCounts(players);
  const seatScores = [];
  const keptSimulations = [];
  for (let seat = 0; seat < seatCount; seat += 1) {
    const controlledTeamId = teams[seat % teams.length].id;
    const simulation = await simulateAutodraft({
      players,
      teams,
      budget,
      rosterSize,
      increment,
      rosterRequirements,
      sourceLabel,
      seed: `${seed}-seat-${seat + 1}`,
      maxValueStrategy: ({ state, team, player }) => team.id === controlledTeamId
        ? policyMaxBid(policy, state, team, player, initialPositionCounts)
        : null,
      nominationStrategy: ({ state, team }) => team.id === controlledTeamId
        ? choosePolicyNomination(policy, state, team.id, initialPositionCounts)
        : null
    });
    const controlled = simulation.state.teams.find((team) => team.id === controlledTeamId);
    const playerMap = new Map(simulation.state.players.map((player) => [player.id, player]));
    const values = controlled.roster.map((spot) => {
      const value = Math.max(0, Number(playerMap.get(spot.playerId)?.suggestedValue) || 0);
      return value;
    });
    const l1Value = values.reduce((sum, value) => sum + value, 0);
    const l2Value = values.reduce((sum, value) => sum + value * value, 0);
    const score = l1Value + l2Weight * l2Value / valueScale;
    seatScores.push({ seat: seat + 1, teamId: controlledTeamId, score, l1Value, l2Value });
    if (keepSimulation) keptSimulations.push(simulation);
  }
  return {
    fitness: seatScores.reduce((sum, item) => sum + item.score, 0) / seatScores.length,
    seatScores,
    simulation: keptSimulations[0] || null,
    simulations: keptSimulations
  };
}

function choosePolicyNomination(policy, state, teamId, initialPositionCounts) {
  const team = state.teams.find((item) => item.id === teamId);
  return state.players
    .filter((player) => player.status === "available" && canTeamRosterPlayer(state, teamId, player.id))
    .sort((left, right) => {
      const scoreDifference = nominationScore(policy, state, team, right, initialPositionCounts)
        - nominationScore(policy, state, team, left, initialPositionCounts);
      return scoreDifference || left.id.localeCompare(right.id);
    })[0]?.id || null;
}

export function policyMaxBid(policy, state, team, player, initialPositionCounts = positionCounts(state.players)) {
  const features = policyFeatures(state, team, player, initialPositionCounts);
  const position = normalizePosition(player.position);
  const multiplier = Number(policy.bidBaseMultiplier)
    + Number(policy.bidEliteSlope) * features.elite
    + Number(policy[`bid${position}Adjustment`] || 0)
    + Number(policy.bidRequiredNeedBonus) * features.requiredNeed
    + Number(policy.bidFlexNeedBonus) * features.flexNeed
    + Number(policy.bidScarcityBonus) * features.scarcity
    + Number(policy.bidBudgetFlex) * features.budgetFlex
    + Number(policy.bidMarketGapWeight) * features.marketGap;
  return Math.max(0, Math.round(features.value * clamp(multiplier, 0, 3)));
}

export function referenceMaxBid(policy, player) {
  const value = Math.max(1, Number(player.suggestedValue) || 1);
  const elite = clamp((value - 20) / 40, -0.5, 1.5);
  const position = normalizePosition(player.position);
  const multiplier = Number(policy.bidBaseMultiplier)
    + Number(policy.bidEliteSlope) * elite
    + Number(policy[`bid${position}Adjustment`] || 0)
    + Number(policy.bidMarketGapWeight) * marketGap(player, value);
  return Math.max(0, Math.round(value * clamp(multiplier, 0, 3)));
}

function nominationScore(policy, state, team, player, initialPositionCounts) {
  const features = policyFeatures(state, team, player, initialPositionCounts);
  const position = normalizePosition(player.position);
  return Number(policy.nomValueWeight) * features.value
    + Number(policy.nomEliteWeight) * (features.value ** 2 / 50)
    + Number(policy.nomNeedWeight) * features.value * Math.max(features.requiredNeed, features.flexNeed)
    + Number(policy.nomScarcityWeight) * features.value * features.scarcity
    + Number(policy.nomMarketWeight) * (features.marketAverage - features.value)
    + Number(policy[`nom${position}Adjustment`] || 0);
}

function policyFeatures(state, team, player, initialPositionCounts) {
  const position = normalizePosition(player.position);
  const value = Math.max(1, Number(player.suggestedValue) || 1);
  const counts = rosterPositionCounts(state, team);
  const requirements = state.config.rosterRequirements || {};
  const requiredNeed = Math.max(0, Number(requirements[position] || 0) - Number(counts[position] || 0)) > 0 ? 1 : 0;
  const flexEligible = ["RB", "WR", "TE"].includes(position);
  const extraFlexPlayers = ["RB", "WR", "TE"].reduce((sum, item) => sum + Math.max(0, Number(counts[item] || 0) - Number(requirements[item] || 0)), 0);
  const flexNeed = flexEligible && Math.max(0, Number(requirements.FLEX || 0) - extraFlexPlayers) > 0 ? 1 : 0;
  const remainingAtPosition = state.players.filter((item) => item.status === "available" && normalizePosition(item.position) === position).length;
  const scarcity = clamp(1 - remainingAtPosition / Math.max(1, Number(initialPositionCounts[position] || 1)), 0, 1);
  const openSlots = Math.max(1, Number(state.config.rosterSize) - team.roster.length);
  const baselinePerSlot = Number(state.config.budget) / Math.max(1, Number(state.config.rosterSize));
  const budgetFlex = clamp(team.budget / openSlots / Math.max(1, baselinePerSlot) - 1, -1, 1);
  const marketAverage = Math.max(1, Number(player.marketAverage) || value);
  return { value, marketAverage, marketGap: marketGap(player, value), elite: clamp((value - 20) / 40, -0.5, 1.5), requiredNeed, flexNeed, scarcity, budgetFlex };
}

function marketGap(player, value) {
  return clamp((Math.max(1, Number(player?.marketAverage) || value) - value) / Math.max(1, value), -1, 1);
}

function rosterPositionCounts(state, team) {
  const counts = Object.fromEntries(POSITIONS.map((position) => [position, 0]));
  for (const spot of team.roster) {
    const player = state.players.find((item) => item.id === spot.playerId);
    const position = normalizePosition(player?.position);
    counts[position] = Number(counts[position] || 0) + 1;
  }
  return counts;
}

function positionCounts(players) {
  const counts = Object.fromEntries(POSITIONS.map((position) => [position, 0]));
  for (const player of players) {
    const position = normalizePosition(player.position);
    counts[position] = Number(counts[position] || 0) + 1;
  }
  return counts;
}

function normalizePosition(value) {
  const position = String(value || "").toUpperCase();
  return POSITIONS.includes(position) ? position : "WR";
}

function initialPopulation({ populationSize, random }) {
  const baseline = POLICY_PARAMETERS.map((item) => item.initial);
  return Array.from({ length: populationSize }, (_, candidateIndex) => {
    if (candidateIndex === 0) return [...baseline];
    return baseline.map((value, index) => {
      const definition = POLICY_PARAMETERS[index];
      const spread = (definition.max - definition.min) * (candidateIndex < 4 ? 0.08 : 0.18);
      return clampParameter(value + gaussian(random) * spread, definition);
    });
  });
}

function nextPopulation({ evaluated, populationSize, eliteCount, mutationRate, mutationScale, random }) {
  const elites = evaluated.slice(0, Math.min(eliteCount, populationSize)).map((candidate) => [...candidate.vector]);
  const next = [...elites];
  while (next.length < populationSize) {
    const left = tournament(evaluated, random).vector;
    const right = tournament(evaluated, random).vector;
    const child = left.map((parameterValue, index) => random() < 0.5 ? parameterValue : right[index]);
    for (let index = 0; index < child.length; index += 1) {
      if (random() >= mutationRate) continue;
      const definition = POLICY_PARAMETERS[index];
      const spread = (definition.max - definition.min) * mutationScale;
      child[index] = clampParameter(child[index] + gaussian(random) * spread, definition);
    }
    next.push(child);
  }
  return next;
}

function tournament(evaluated, random, size = 3) {
  let winner = evaluated[Math.floor(random() * evaluated.length)];
  for (let index = 1; index < size; index += 1) {
    const challenger = evaluated[Math.floor(random() * evaluated.length)];
    if (challenger.fitness > winner.fitness) winner = challenger;
  }
  return winner;
}

function cloneCandidate(candidate) {
  return { ...candidate, vector: [...candidate.vector], seatScores: candidate.seatScores.map((item) => ({ ...item })) };
}

export function policyFromVector(vector) {
  return Object.fromEntries(POLICY_PARAMETERS.map((definition, index) => [definition.key, clampParameter(vector[index], definition)]));
}

function parameter(key, label, min, max, initial) {
  return Object.freeze({ key, label, min, max, initial });
}

function clampParameter(value, definition) {
  return Math.round(clamp(Number(value), definition.min, definition.max) * 10_000) / 10_000;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function gaussian(random) {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function seededRandom(seed) {
  let state = 2166136261;
  for (const character of String(seed)) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function renderEvolutionReport(result, source) {
  const simulations = (result.exampleSimulations?.length ? result.exampleSimulations : [result.exampleSimulation]).filter(Boolean);
  const examples = simulations.slice(0, 3).map((simulation, index) => {
    const seatScore = result.seatScores[index];
    const controlledTeamId = seatScore?.teamId;
    const controlled = simulation.state.teams.find((team) => team.id === controlledTeamId);
    const lotMaximums = new Map(simulation.lots.map((lot) => [lot.player.id, lot.intents.find((item) => item.teamId === controlledTeamId)?.maximum ?? 0]));
    const playerMap = new Map(source.players.map((player) => [player.id, { ...player, maxBid: lotMaximums.get(player.id) ?? referenceMaxBid(result.policy, player) }]));
    const roster = controlled.roster.map((spot) => ({ ...playerMap.get(spot.playerId), price: spot.price }))
      .sort((left, right) => Number(right.suggestedValue) - Number(left.suggestedValue));
    return { controlled, roster, seatScore };
  });
  const strategy = source.players.map((player) => ({ ...player, maxBid: referenceMaxBid(result.policy, player) }))
    .sort((left, right) => right.maxBid - left.maxBid || Number(right.suggestedValue) - Number(left.suggestedValue));
  const parameters = POLICY_PARAMETERS.map((definition) => ({ ...definition, value: result.policy[definition.key] }));
  const { l2Weight, valueScale } = result.reward;
  const points = result.history.map((entry) => {
    const width = result.history.length > 1 ? (entry.generation - 1) / (result.history.length - 1) * 100 : 0;
    const maximum = Math.max(...result.history.map((item) => item.allTimeBestFitness), 1);
    const height = entry.allTimeBestFitness / maximum * 100;
    return `<i style="left:${width}%;height:${height}%" title="Generation ${entry.generation}: ${formatNumber(entry.allTimeBestFitness)}"></i>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evolved Autodraft Strategy</title><style>${reportCss()}</style></head><body><main>
    <p class="eyebrow">SUN GOD · EVOLUTIONARY SEARCH</p><h1>Evolved contextual policy</h1><p class="lede">${POLICY_PARAMETERS.length} smooth parameters generate maximum bids from value, position, roster need, scarcity, and budget. Nomination priorities are optimized separately. Fitness is mean [Σ value + ${formatDecimal(l2Weight)} × Σ value² / ${formatDecimal(valueScale)}].</p>
    <section class="metrics"><div><b>${formatNumber(result.fitness)}</b><span>FITNESS</span></div><div><b>${source.teams.length}</b><span>LEAGUE TEAMS</span></div><div><b>${result.generations}</b><span>GENERATIONS</span></div><div><b>${result.populationSize}</b><span>POPULATION</span></div><div><b>${result.evaluations}</b><span>SEATS / CANDIDATE</span></div></section>
    <section><h2>Search history</h2><div class="chart">${points}</div></section>
    <section><h2>Evolved policy parameters</h2><table><thead><tr><th>Parameter</th><th>Value</th><th>Allowed range</th></tr></thead><tbody>${parameters.map((item) => `<tr><td><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.key)}</small></td><td>${item.value}</td><td>${item.min} to ${item.max}</td></tr>`).join("")}</tbody></table></section>
    <section><h2>Example controlled rosters</h2><p>The same evolved policy drafting from ${examples.length} different nomination seats.</p>${examples.map(({ controlled, roster, seatScore }, index) => `<div class="roster-example"><h3>Example ${index + 1} · ${escapeHtml(controlled.name)}</h3><p>$${controlled.budget} remaining · score ${formatNumber(seatScore.score)} (${formatNumber(seatScore.l1Value)} total value + scaled elite bonus)</p><table><thead><tr><th>Pos</th><th>Player</th><th>Suggested</th><th>Yahoo Avg</th><th>Contextual max</th><th>Paid</th><th>Reward</th></tr></thead><tbody>${roster.map((player) => { const value = Number(player.suggestedValue) || 0; return `<tr><td>${escapeHtml(player.position)}</td><td><b>${escapeHtml(player.name)}</b></td><td>$${value}</td><td>$${player.marketAverage || value}</td><td>$${player.maxBid}</td><td>$${player.price}</td><td>${formatDecimal(value + l2Weight * value ** 2 / valueScale)}</td></tr>`; }).join("")}</tbody></table></div>`).join("")}</section>
    <section><h2>Neutral-context bid curve</h2><p>Reference ceilings use projected value, position, and Yahoo market gap. Live ceilings also respond to roster need, scarcity, and budget.</p><table><thead><tr><th>Rank</th><th>Pos</th><th>Player</th><th>Suggested</th><th>Yahoo Avg</th><th>Reference max</th></tr></thead><tbody>${strategy.map((player, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(player.position)}</td><td><b>${escapeHtml(player.name)}</b></td><td>$${player.suggestedValue}</td><td>$${player.marketAverage || player.suggestedValue}</td><td>$${player.maxBid}</td></tr>`).join("")}</tbody></table></section>
  </main></body></html>`;
}

function strategyPayload(result, source) {
  const referencePlayers = source.players.map((player) => ({
    id: player.id,
    name: player.name,
    position: player.position,
    suggestedValue: player.suggestedValue,
    marketAverage: player.marketAverage,
    marketProjected: player.marketProjected,
    marketSource: player.marketSource,
    referenceMaxBid: referenceMaxBid(result.policy, player)
  }));
  return {
    generatedAt: new Date().toISOString(),
    seed: result.seed,
    objective: result.objective,
    fitness: result.fitness,
    seatScores: result.seatScores,
    reward: result.reward,
    training: { generations: result.generations, population: result.populationSize, evaluations: result.evaluations },
    league: { teams: source.teams.length, budget: source.budget, rosterSize: source.rosterSize, increment: source.increment, rosterRequirements: source.rosterRequirements },
    source: source.sourceLabel,
    policy: result.policy,
    parameterDefinitions: POLICY_PARAMETERS,
    referenceMaxValuesByPlayerId: Object.fromEntries(referencePlayers.map((player) => [player.id, player.referenceMaxBid])),
    players: referencePlayers,
    history: result.history
  };
}

export function parseEvolutionArgs(argv) {
  const options = {
    generations: 25, populationSize: 28, evaluations: 3, eliteCount: 4,
    mutationRate: 0.20, mutationScale: 0.12, l2Weight: 0.50, valueScale: 50, seed: "evolution-1",
    outputPath: DEFAULT_OUTPUT, reportPath: DEFAULT_REPORT, playersPath: null,
    yahooValuesPath: undefined,
    draftStatePath: null, teamCount: 12, budget: null, rosterSize: null,
    increment: null, rosterRequirements: null, help: false
  };
  const flags = new Set(["--generations", "--population", "--evaluations", "--elite", "--mutation-rate", "--mutation-scale", "--l2-weight", "--value-scale", "--seed", "--output", "--report", "--players", "--yahoo-values", "--draft-state", "--teams", "--budget", "--roster-size", "--increment", "--requirements"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") { options.help = true; continue; }
    if (flag === "--no-market-values") { options.yahooValuesPath = false; continue; }
    if (!flags.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    if (flag === "--generations") options.generations = positiveInteger(value, flag);
    else if (flag === "--population") options.populationSize = positiveInteger(value, flag);
    else if (flag === "--evaluations") options.evaluations = positiveInteger(value, flag);
    else if (flag === "--elite") options.eliteCount = positiveInteger(value, flag);
    else if (flag === "--mutation-rate") options.mutationRate = probability(value, flag);
    else if (flag === "--mutation-scale") options.mutationScale = positiveNumber(value, flag);
    else if (flag === "--l2-weight") options.l2Weight = nonnegativeNumber(value, flag);
    else if (flag === "--value-scale") options.valueScale = positiveNumber(value, flag);
    else if (flag === "--seed") options.seed = String(value).trim() || "evolution-1";
    else if (flag === "--output") options.outputPath = resolve(value);
    else if (flag === "--report") options.reportPath = resolve(value);
    else if (flag === "--players") options.playersPath = resolve(value);
    else if (flag === "--yahoo-values") options.yahooValuesPath = resolve(value);
    else if (flag === "--draft-state") options.draftStatePath = resolve(value);
    else if (flag === "--teams") options.teamCount = positiveInteger(value, flag);
    else if (flag === "--budget") options.budget = positiveInteger(value, flag);
    else if (flag === "--roster-size") options.rosterSize = positiveInteger(value, flag);
    else if (flag === "--increment") options.increment = positiveInteger(value, flag);
    else if (flag === "--requirements") options.rosterRequirements = parseRequirements(value);
  }
  if (options.populationSize < 2) throw new Error("--population must be at least 2.");
  if (options.eliteCount >= options.populationSize) throw new Error("--elite must be smaller than --population.");
  return options;
}

async function main() {
  try {
    const options = parseEvolutionArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(HELP); return; }
    const source = await loadSimulationSource(options);
    process.stdout.write(`Evolving ${POLICY_PARAMETERS.length} policy parameters across ${source.players.length} players · ${options.populationSize} candidates × ${options.generations} generations × ${Math.min(options.evaluations, source.teams.length)} seats...\n`);
    const result = await evolveAutodraftStrategy({
      ...source,
      generations: options.generations,
      populationSize: options.populationSize,
      evaluations: options.evaluations,
      eliteCount: options.eliteCount,
      mutationRate: options.mutationRate,
      mutationScale: options.mutationScale,
      l2Weight: options.l2Weight,
      valueScale: options.valueScale,
      seed: options.seed,
      onGeneration: (entry) => process.stdout.write(`Generation ${entry.generation}/${options.generations} · best ${formatNumber(entry.bestFitness)} · all-time ${formatNumber(entry.allTimeBestFitness)} · mean ${formatNumber(entry.meanFitness)}\n`)
    });
    await mkdir(dirname(options.outputPath), { recursive: true });
    await mkdir(dirname(options.reportPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(strategyPayload(result, source), null, 2)}\n`, "utf8");
    await writeFile(options.reportPath, renderEvolutionReport(result, source), "utf8");
    process.stdout.write(`Complete · fitness ${formatNumber(result.fitness)}\nStrategy: ${options.outputPath}\nReport: ${options.reportPath}\n`);
  } catch (error) {
    process.stderr.write(`Evolution failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

function parseRequirements(value) {
  const supported = ["QB", "RB", "WR", "TE", "FLEX", "K", "DST"];
  const result = Object.fromEntries(supported.map((position) => [position, 0]));
  for (const entry of String(value).split(",").filter(Boolean)) {
    const [rawPosition, rawCount] = entry.split(/[=:]/);
    const position = String(rawPosition || "").trim().toUpperCase();
    const count = Number(rawCount);
    if (!supported.includes(position) || !Number.isInteger(count) || count < 0) throw new Error(`Invalid requirement: ${entry}`);
    result[position] = count;
  }
  return result;
}

function positiveInteger(value, flag) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} needs a positive whole number.`); return number; }
function positiveNumber(value, flag) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} needs a positive number.`); return number; }
function nonnegativeNumber(value, flag) { const number = Number(value); if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} needs a nonnegative number.`); return number; }
function probability(value, flag) { const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${flag} must be between 0 and 1.`); return number; }
function formatNumber(value) { return Math.round(Number(value) || 0).toLocaleString("en-US"); }
function formatDecimal(value) { return (Math.round((Number(value) || 0) * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function reportCss() { return `:root{font-family:Inter,system-ui,sans-serif;color:#1d1710;background:#e8dcc2}*{box-sizing:border-box}body{margin:0}main{width:min(1100px,92vw);margin:auto;padding:56px 0 100px}.eyebrow{font:800 10px monospace;letter-spacing:.14em;color:#756854}h1{font-size:clamp(44px,8vw,80px);line-height:.92;letter-spacing:-.06em;margin:12px 0}.lede{max-width:700px;color:#675b4b;line-height:1.6}.metrics{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid;margin:32px 0 60px;background:#faf1dd}.metrics div{padding:20px;border-right:1px solid}.metrics div:last-child{border:0}.metrics b,.metrics span{display:block}.metrics b{font-size:26px}.metrics span{font:700 8px monospace;color:#756854;margin-top:5px}section{margin-top:54px}h2{font-size:28px;letter-spacing:-.035em}h3{font-size:20px;margin:0 0 4px}.roster-example{margin-top:30px}.roster-example>p{margin:0 0 12px;color:#675b4b}.chart{height:180px;border:1px solid;background:#faf1dd;display:flex;align-items:flex-end;position:relative;padding:10px}.chart i{position:absolute;bottom:10px;width:5px;min-height:3px;background:#cf941c;border-radius:3px 3px 0 0}table{width:100%;border-collapse:collapse;background:#faf1dd;border:1px solid;font-size:12px}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #d7c8aa}th{font:700 8px monospace;color:#756854;text-transform:uppercase}td:nth-last-child(-n+4),th:nth-last-child(-n+4){text-align:right}@media(max-width:700px){.metrics{grid-template-columns:repeat(2,1fr)}table{font-size:10px}th,td{padding:7px 5px}}`; }

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
