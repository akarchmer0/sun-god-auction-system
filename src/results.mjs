import {
  buildResultsPayload,
  decodeResultsPayload,
  resultsToCsv,
  platformResultsText
} from "./draft-io.mjs";

const STORAGE_KEY = "gavel-draft-v1";
const app = document.querySelector("#results-app");
let payload = null;
let messageTimer = null;

void initialize();

async function initialize() {
  try {
    const encoded = location.hash.slice(1);
    if (encoded) payload = await decodeResultsPayload(encoded);
    else {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!state) throw new Error("No draft results were found on this device.");
      payload = buildResultsPayload(state);
    }
    render();
    wireEvents();
  } catch (error) {
    app.innerHTML = `<main class="results-error"><span class="sun-seal">☀</span><h1>Results unavailable</h1><p>${escapeHtml(error.message)}</p><a href="./">Return to the draft room</a></main>`;
  }
}

function render() {
  const totalSpent = payload.sales.reduce((sum, sale) => sum + sale.price, 0);
  const topSale = [...payload.sales].sort((a, b) => b.price - a.price)[0] || null;
  const bestValue = [...payload.sales].sort((a, b) => (b.suggestedValue - b.price) - (a.suggestedValue - a.price))[0] || null;
  const average = payload.sales.length ? Math.round(totalSpent / payload.sales.length) : 0;
  app.innerHTML = `<div class="results-shell">
    <header class="results-topbar">
      <a class="results-brand" href="./"><span class="sun-seal">☀</span><span><strong>Sun God</strong><small>AUCTION SYSTEMS</small></span></a>
      <div class="results-actions"><button data-action="copy-link">Copy share link</button><button data-action="print">Print</button><a href="./">Back to draft</a></div>
    </header>
    <main>
      <section class="results-hero">
        <span class="eyebrow">POST-DRAFT REPORT · ${escapeHtml(formatDate(payload.generatedAt))}</span>
        <h1>The room has spoken.</h1>
        <p>A complete, portable record of every roster and winning bid.</p>
        <div class="summary-metrics">
          ${metric(payload.teams.length, "Fantasy teams")}
          ${metric(payload.sales.length, "Players sold")}
          ${metric(`$${totalSpent}`, "Total spent")}
          ${metric(`$${average}`, "Average sale")}
        </div>
      </section>

      <section class="standouts">
        <article><span>TOP SALE</span>${topSale ? `<strong>${escapeHtml(topSale.playerName)}</strong><p>$${topSale.price} · ${escapeHtml(topSale.fantasyTeam)}</p>` : `<strong>No sales yet</strong><p>Completed sales will appear here.</p>`}</article>
        <article><span>BEST VALUE VS. SUGGESTED</span>${bestValue ? `<strong>${escapeHtml(bestValue.playerName)}</strong><p>${signedMoney(bestValue.suggestedValue - bestValue.price)} · ${escapeHtml(bestValue.manager)}</p>` : `<strong>No sales yet</strong><p>Suggested values power this comparison.</p>`}</article>
        <article><span>LEAGUE FORMAT</span><strong>$${payload.config.budget} cap</strong><p>${payload.config.rosterSize} roster spots · $${payload.config.increment} increment</p></article>
      </section>

      <section class="export-panel">
        <div><span class="eyebrow">TAKE IT WITH YOU</span><h2>Export draft results</h2><p>Download a universal CSV or copy a tab-separated table arranged for your league platform.</p></div>
        <div class="export-controls">
          <select id="platform-format" aria-label="Copy format"><option value="espn">ESPN format</option><option value="yahoo">Yahoo format</option><option value="sleeper">Sleeper format</option></select>
          <button data-action="copy-results">Copy table</button><button class="is-dark" data-action="download-csv">Download CSV</button>
        </div>
        <textarea id="platform-output" aria-label="Copyable results" readonly>${escapeHtml(platformResultsText(payload, "espn"))}</textarea>
      </section>

      <section class="rosters-section"><div class="section-heading"><span class="eyebrow">FINAL ROSTERS</span><h2>Team by team</h2></div><div class="roster-grid">${payload.teams.map(teamCard).join("")}</div></section>
    </main>
    <div id="results-notice" role="status"></div>
  </div>`;
}

function teamCard(team) {
  return `<article class="result-team" style="--team:${escapeHtml(team.color || "#d39a20")}">
    <header><i></i><span><strong>${escapeHtml(team.name)}</strong><small>${escapeHtml(team.manager)}</small></span><b>$${team.budgetRemaining}<small>LEFT</small></b></header>
    <div class="team-spend"><span><i style="width:${Math.min(100, Math.max(0, team.spent / Math.max(1, team.budgetStart) * 100))}%"></i></span><small>$${team.spent} spent of $${team.budgetStart}</small></div>
    <div class="result-roster">${team.roster.length ? [...team.roster].sort((a, b) => positionOrder(a.position) - positionOrder(b.position)).map((player) => `<div><span>${escapeHtml(player.position)}</span><strong>${escapeHtml(player.name)}<small>${escapeHtml(player.nflTeam)}</small></strong><b>$${player.price}</b></div>`).join("") : `<p>No players drafted.</p>`}</div>
  </article>`;
}

function wireEvents() {
  app.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "print") return window.print();
    if (action === "copy-link") return copyText(location.href, "Share link copied.");
    if (action === "copy-results") return copyText(document.querySelector("#platform-output")?.value || "", "Results table copied.");
    if (action === "download-csv") return downloadCsv();
  });
  app.addEventListener("change", (event) => {
    if (event.target.id === "platform-format") document.querySelector("#platform-output").value = platformResultsText(payload, event.target.value);
  });
}

async function copyText(text, confirmation) {
  try {
    await navigator.clipboard.writeText(text);
    showMessage(confirmation);
  } catch {
    window.prompt("Copy this text:", text);
  }
}

function downloadCsv() {
  const blob = new Blob([resultsToCsv(payload)], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `sun-god-draft-results-${new Date(payload.generatedAt).toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showMessage("CSV downloaded.");
}

function showMessage(text) {
  const notice = document.querySelector("#results-notice");
  notice.textContent = text;
  notice.classList.add("is-visible");
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => notice.classList.remove("is-visible"), 2500);
}

function metric(value, label) {
  return `<div><strong>${value}</strong><span>${label}</span></div>`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(value));
}

function signedMoney(value) {
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value)}`;
}

function positionOrder(position) {
  const index = ["QB", "RB", "WR", "TE", "FLEX", "K", "DST"].indexOf(position);
  return index < 0 ? 99 : index;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}
