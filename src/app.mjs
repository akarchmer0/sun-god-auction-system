import { seedPlayers, makeTeams } from "./data.mjs";
import { fantasyProsPlayers } from "./fantasy-pros-data.mjs";
import { AuctioneerVoice } from "./auctioneer-voice.mjs";
import { createAuctioneerScript } from "./auctioneer-script.mjs";
import { classifyPhoneBidBatch } from "./phone-bidding.mjs";
import {
  VISUAL_BID_WINDOW_MS,
  bidsShareWindow,
  nextVisualBidAmount
} from "./vision-bidding.mjs";
import {
  createDraft,
  nominatePlayer,
  openAuction,
  pauseAuction,
  placeBid,
  advanceCountdown,
  moveToNextPlayer,
  undoLastSale,
  currentPlayer,
  maxBidForTeam,
  currentNominator,
  canTeamRosterPlayer,
  ROSTER_POSITIONS
} from "./domain.mjs";

const STORAGE_KEY = "gavel-draft-v1";
const PHONE_ROOM_ID_STORAGE_KEY = "sun-god-phone-room-id";
const PHONE_ROOM_HOST_KEY_STORAGE_KEY = "sun-god-phone-room-host-key";
const COUNTDOWN_DELAYS = { open: 8000, once: 5200, twice: 4200 };
const SPEECH_PRIORITY = { nomination: 30, countdown: 50, bid: 100, sold: 110, ruling: 120 };
const STANDARD_ROSTER_REQUIREMENTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };
const app = document.querySelector("#app");
let state = restoreDraft() || createDraft({
  players: seedPlayers,
  teams: makeTeams(),
  budget: 200,
  rosterSize: 15,
  rosterRequirements: STANDARD_ROSTER_REQUIREMENTS
});
let voiceEnabled = true;
let autoEnabled = true;
let setupStep = 1;
let countdownTimer = null;
let notice = null;
let pendingVisualTie = null;
let visualBidWindow = null;
let phoneRoomEvents = null;
let phoneRoomSyncTimer = null;
let phoneRoom = {
  roomId: localStorage.getItem(PHONE_ROOM_ID_STORAGE_KEY) || createRoomCode(),
  hostKey: localStorage.getItem(PHONE_ROOM_HOST_KEY_STORAGE_KEY) || createHostKey(),
  status: "starting",
  joinUrl: "",
  claimedTeamIds: [],
  error: null
};
let auctioneerService = {
  status: "checking",
  available: null,
  provider: "cartesia",
  model: null,
  voiceId: null,
  message: "Checking Cartesia's realtime auctioneer."
};
const auctioneerScript = createAuctioneerScript();
const auctioneerVoice = new AuctioneerVoice({
  onStatusChange: (snapshot) => {
    const changed = snapshot.status !== auctioneerService.status
      || snapshot.available !== auctioneerService.available
      || snapshot.message !== auctioneerService.message;
    auctioneerService = snapshot;
    if (changed) render();
  }
});
render();
wireGlobalEvents();
void auctioneerVoice.initialize();
void initializePhoneRoom();

function render() {
  const player = currentPlayer(state);
  const highBidder = state.teams.find((team) => team.id === state.auction.highBidderId);
  const nextNominator = currentNominator(state);
  const lotNominator = state.teams.find((team) => team.id === state.auction.nominatorTeamId) || nextNominator;
  const available = state.players.filter((item) => item.status === "available");
  const nextPlayers = state.queue
    .map((id) => state.players.find((item) => item.id === id))
    .filter((item) => item?.status === "available" && item.id !== player?.id)
    .slice(0, 7);

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <button class="brand" data-action="setup" aria-label="Open league setup">
          <span class="sun-mark">${sunLogo()}</span>
          <span><strong>Sun God</strong><small>AUCTION SYSTEMS</small></span>
        </button>
        <div class="room-state">
          <span class="live-dot ${["open", "once", "twice"].includes(state.auction.phase) ? "is-live" : ""}"></span>
          <span>${phaseLabel(state.auction.phase)}</span>
          <span class="room-divider"></span>
          <span>${state.sales.length} sold</span>
          <span>${available.length} available</span>
          <span class="room-divider"></span>
          <span>${escapeHtml(nextNominator?.manager || "Commissioner")} ${["sold", "passed"].includes(state.auction.phase) ? "nominates next" : "nominates"}</span>
        </div>
        <div class="device-controls">
          <button class="device-button ${phoneRoom.status === "live" ? "is-on" : ""}" data-action="focus-phone-room" title="Show phone bidding room">${icon("phone")} <span>${phoneRoom.claimedTeamIds.length}/${state.teams.length} phones</span></button>
          <button class="icon-button ${voiceEnabled ? "is-on" : ""}" data-action="voice" title="${escapeHtml(auctioneerVoiceTitle())}">${icon("volume")}</button>
          <button class="icon-button" data-action="setup" title="League setup">${icon("settings")}</button>
        </div>
      </header>

      ${notice ? `<div class="notice ${notice.kind}"><span>${escapeHtml(notice.message)}</span><button data-action="dismiss-notice">×</button></div>` : ""}
      ${pendingVisualTie ? visualTieConfirmation() : ""}

      <main class="draft-grid">
        <section id="phone-room-panel" class="phone-room-panel panel">
          <div class="panel-heading">
            <div><span class="eyebrow">PHONE BIDDING</span><h2>Draft room</h2></div>
            <span class="phone-room-status ${phoneRoom.status === "live" ? "is-live" : ""}"><i></i>${phoneRoomStatusLabel()}</span>
          </div>
          <div class="phone-join-card">
            <div class="phone-qr">${phoneRoom.joinUrl ? qrCodeSvg(phoneRoom.joinUrl) : `<span>${icon("phone")}</span>`}</div>
            <div class="phone-join-copy">
              <small>ROOM CODE</small>
              <strong>${escapeHtml(phoneRoom.roomId)}</strong>
              <p>${phoneRoom.joinUrl ? "Scan to join on the same Wi-Fi." : "Preparing the phone room…"}</p>
              <span title="${escapeHtml(phoneRoom.joinUrl)}">${escapeHtml(phoneRoom.joinUrl || "Finding this Mac’s network address…")}</span>
            </div>
          </div>
          <div class="phone-room-actions">
            <button data-action="copy-phone-link" ${phoneRoom.joinUrl ? "" : "disabled"}>${icon("copy")} Copy join link</button>
            <button data-action="reset-phone-claims" ${phoneRoom.claimedTeamIds.length ? "" : "disabled"}>Reset phones</button>
          </div>
          <div class="phone-claim-summary"><span>PARTICIPANTS</span><strong>${phoneRoom.claimedTeamIds.length}/${state.teams.length} joined</strong></div>
          <div class="phone-claim-grid">
            ${state.teams.map((team) => {
              const joined = phoneRoom.claimedTeamIds.includes(team.id);
              return `<div class="phone-claim ${joined ? "is-joined" : ""}"><i style="background:${team.color}"></i><span><strong>${escapeHtml(team.manager)}</strong><small>${joined ? "PHONE READY" : "WAITING"}</small></span>${icon(joined ? "check" : "phone")}</div>`;
            }).join("")}
          </div>
          <p class="camera-note">Each manager scans once, chooses their team, then uses the next-dollar button, an easy jump, or a custom whole-dollar bid. The laptop remains authoritative for budgets, rosters, and simultaneous bids.</p>
        </section>

        <section class="auction-stage">
          <div class="stage-glow"></div>
          ${player ? playerCard(player, highBidder, lotNominator) : emptyStage(nextNominator)}
        </section>

        <aside class="queue-panel panel">
          <div class="panel-heading">
            <div><span class="eyebrow">ON DECK</span><h2>Player board</h2><span class="nomination-chip">${escapeHtml(nextNominator?.manager || "Commissioner")} is up</span></div>
            <label class="search-box">${icon("search")}<input id="player-search" placeholder="Find player" autocomplete="off" /></label>
          </div>
          <div id="search-results" class="search-results"></div>
          <div class="queue-list">
            ${nextPlayers.length ? nextPlayers.map((item, index) => queueRow(item, index)).join("") : `<p class="empty-copy">No players left in the queue.</p>`}
          </div>
          <div class="queue-actions">
            <button class="fantasy-pros-button" data-action="load-fantasy-pros" title="Replace the current draft with the supplied FantasyPros player list and auction values">
              ${icon("database")}
              <span><strong>Load FantasyPros values</strong><small>${fantasyProsPlayers.length} players · resets draft</small></span>
              ${icon("arrow")}
            </button>
            <button class="text-button csv-import-button" data-action="import">${icon("upload")} Or import player CSV</button>
            <input id="csv-input" type="file" accept=".csv,text/csv" hidden />
          </div>
        </aside>

        <section class="bidding-panel panel">
          <div class="bidder-heading">
            <div><span class="eyebrow">BIDDER CONSOLE</span><h2>Who has the bid?</h2></div>
            <div class="manual-bid">
              <label for="manual-amount">Next bid</label>
              <span>$</span><input id="manual-amount" type="number" min="1" value="${Math.max(1, state.auction.amount + state.config.increment)}" />
            </div>
          </div>
          <div class="team-grid">
            ${state.teams.map((team, index) => teamBidButton(team, index)).join("")}
          </div>
          <div class="keyboard-hint"><kbd>1</kbd>–<kbd>${Math.min(9, state.teams.length)}</kbd> quick bid <span>•</span> Joined phones bid directly for their selected manager</div>
        </section>

        <aside class="ledger-panel panel">
          <div class="panel-heading">
            <div><span class="eyebrow">DRAFT LEDGER</span><h2>Recent sales</h2></div>
            <button class="text-button" data-action="undo" ${state.sales.length ? "" : "disabled"}>Undo last</button>
          </div>
          <div class="sales-list">
            ${state.sales.length ? [...state.sales].reverse().slice(0, 5).map(saleRow).join("") : `<p class="empty-copy">Every completed sale will appear here.</p>`}
          </div>
        </aside>
      </main>
    </div>
    <dialog id="setup-dialog">${setupDialog()}</dialog>
  `;
}

function playerCard(player, highBidder, nominator) {
  const canOpen = ["ready", "paused"].includes(state.auction.phase);
  const inProgress = ["open", "once", "twice"].includes(state.auction.phase);
  const done = ["sold", "passed"].includes(state.auction.phase);
  const statusCopy = state.auction.phase === "sold"
    ? `SOLD TO ${highBidder?.name?.toUpperCase()}`
    : state.auction.phase === "passed" ? "NO SALE" : phaseLabel(state.auction.phase).toUpperCase();
  return `
    <div class="lot-number">LOT ${String(state.sales.length + 1).padStart(2, "0")} · ${escapeHtml(nominator?.manager || "Commissioner")}’S NOMINATION</div>
    <div class="position-badge">${player.position}</div>
    <div class="player-identity">
      <span class="nfl-team">${player.nflTeam}</span>
      <h1>${escapeHtml(player.name)}</h1>
      <p>Suggested value <strong>$${player.suggestedValue}</strong></p>
    </div>
    <div class="bid-display ${state.auction.amount ? "has-bid" : ""}">
      <span class="bid-label">${state.auction.amount ? "CURRENT BID" : "OPENING BID"}</span>
      <div class="bid-number"><sup>$</sup>${state.auction.amount || 1}</div>
      <div class="high-bidder ${highBidder ? "has-leader" : ""}" ${highBidder ? `style="--leader:${highBidder.color}"` : ""}>
        ${highBidder ? `<span class="leader-label">CURRENT WINNING TEAM</span><i></i><span class="leader-copy"><strong>${escapeHtml(highBidder.name)}</strong><small>Managed by ${escapeHtml(highBidder.manager)}</small></span>` : `<span class="waiting-copy">Waiting for the room</span>`}
      </div>
    </div>
    <div class="countdown-state phase-${state.auction.phase}">
      <i></i><span>${statusCopy}</span><i></i>
    </div>
    <div class="stage-actions">
      ${canOpen ? `<button class="primary-action" data-action="open">${state.auction.phase === "paused" ? "Resume auction" : "Start auction"} ${icon("arrow")}</button>` : ""}
      ${inProgress ? `<button class="primary-action" data-action="advance">${state.auction.phase === "twice" ? "Sell player" : "Advance count"} ${icon("arrow")}</button><button class="secondary-action" data-action="pause">Pause</button>` : ""}
      ${done ? `<button class="primary-action" data-action="next">Next player ${icon("arrow")}</button>` : ""}
    </div>
    <label class="auto-control"><input id="auto-toggle" type="checkbox" ${autoEnabled ? "checked" : ""} /><span></span> Auto countdown</label>
  `;
}

function emptyStage(nominator) {
  return `<div class="empty-stage"><span class="sun-mark large">${sunLogo()}</span><span class="eyebrow">${escapeHtml(nominator?.manager || "COMMISSIONER")} IS ON THE CLOCK</span><h1>Nominate the first player</h1><p>Choose a player from the board to begin the draft.</p></div>`;
}

function queueRow(player, index) {
  return `<button class="queue-row" data-action="nominate" data-player-id="${player.id}">
    <span class="queue-index">${String(index + 1).padStart(2, "0")}</span>
    <span class="mini-position ${player.position.toLowerCase()}">${player.position}</span>
    <span class="queue-name"><strong>${escapeHtml(player.name)}</strong><small>${player.nflTeam}</small></span>
    <span class="queue-value">$${player.suggestedValue}</span>
    ${icon("chevron")}
  </button>`;
}

function teamBidButton(team, index) {
  const isHigh = team.id === state.auction.highBidderId;
  const maxBid = maxBidForTeam(state, team.id);
  const phoneJoined = phoneRoom.claimedTeamIds.includes(team.id);
  const legalRosterFit = !state.auction.playerId || canTeamRosterPlayer(state, team.id, state.auction.playerId);
  const disabled = !["open", "once", "twice"].includes(state.auction.phase) || isHigh || !legalRosterFit || maxBid < Math.max(1, state.auction.amount + state.config.increment);
  const title = !legalRosterFit ? "This player would prevent the team from completing its required positions." : "";
  return `<button class="team-bid ${isHigh ? "is-high" : ""}" style="--team:${team.color}" data-action="bid" data-team-id="${team.id}" title="${escapeHtml(title)}" ${disabled ? "disabled" : ""}>
    <span class="team-key" title="Keyboard shortcut ${index < 9 ? index + 1 : "unassigned"}">${index < 9 ? index + 1 : ""}</span>
    <span class="team-swatch"></span>
    <span class="team-copy"><strong>${escapeHtml(team.name)}</strong><small>${escapeHtml(team.manager)} · ${team.roster.length}/${state.config.rosterSize} players</small></span>
    <span class="team-money"><strong>$${team.budget}</strong><small>max $${maxBid}</small></span>
    <span class="armed-label">${isHigh ? "HIGH BID" : "+ BID"}</span>
    <span class="phone-bid-badge" title="${phoneJoined ? "Phone connected" : "Waiting for phone"}">${phoneJoined ? "PHONE READY" : "NO PHONE"}</span>
  </button>`;
}

function saleRow(sale) {
  const player = state.players.find((item) => item.id === sale.playerId);
  const team = state.teams.find((item) => item.id === sale.teamId);
  return `<div class="sale-row"><span class="mini-position ${player.position.toLowerCase()}">${player.position}</span><span><strong>${escapeHtml(player.name)}</strong><small>${escapeHtml(team.name)}</small></span><b>$${sale.amount}</b></div>`;
}

function setupDialog() {
  const requirements = normalizedRequirements();
  const requiredSlots = Object.values(requirements).reduce((sum, value) => sum + value, 0);
  const benchSlots = Math.max(0, state.config.rosterSize - requiredSlots);
  const orderedTeams = orderedTeamsForSetup();
  return `<form id="setup-form" method="dialog">
    <div class="dialog-head"><div><span class="eyebrow">5-MINUTE LEAGUE SETUP</span><h2>Start a new draft</h2></div><button type="button" data-action="close-setup" class="dialog-close" aria-label="Close">×</button></div>
    <div class="setup-progress" aria-label="Setup progress">
      ${["League", "Roster", "Nomination order"].map((label, index) => `<span data-progress-step="${index + 1}" class="${setupStep === index + 1 ? "is-active" : setupStep > index + 1 ? "is-done" : ""}"><i>${index + 1}</i>${label}</span>`).join("")}
    </div>
    <section class="setup-step ${setupStep === 1 ? "is-active" : ""}" data-setup-step="1">
      <p>Set the salary-cap basics. The next two steps define legal rosters and who nominates.</p>
      <div class="form-grid">
        <label>Teams<input name="teamCount" type="number" min="2" max="12" value="${state.teams.length}" required /></label>
        <label>Budget per team<input name="budget" type="number" min="20" max="1000" value="${state.config.budget}" required /></label>
        <label>Bid increment<input name="increment" type="number" min="1" max="20" value="${state.config.increment}" required /></label>
      </div>
    </section>
    <section class="setup-step ${setupStep === 2 ? "is-active" : ""}" data-setup-step="2">
      <p>Set minimum position slots. FLEX accepts RB, WR, or TE; bench slots accept any position.</p>
      <div class="position-requirements">
        ${ROSTER_POSITIONS.map((position) => `<label><span>${position}</span><input name="position_${position}" type="number" min="0" max="10" value="${requirements[position]}" required /></label>`).join("")}
        <label class="bench-position"><span>BENCH</span><input name="benchSlots" type="number" min="0" max="20" value="${benchSlots}" required /></label>
      </div>
      <p class="setup-tip">Sun God blocks a bid when that purchase would leave too few open slots to finish the required lineup.</p>
    </section>
    <section class="setup-step ${setupStep === 3 ? "is-active" : ""}" data-setup-step="3">
      <p>Enter one team per line as <strong>Team name | Manager</strong>. This top-to-bottom list is the repeating nomination order.</p>
      <label class="team-name-field">Teams, managers, and order<textarea name="teamNames" rows="${Math.min(12, Math.max(4, state.teams.length))}" required>${escapeHtml(orderedTeams.map((team) => `${team.name} | ${team.manager}`).join("\n"))}</textarea></label>
      <div class="order-preview"><span>NOMINATION FLOW</span><strong>Top → bottom → repeat</strong></div>
    </section>
    <div class="dialog-actions">
      <button type="button" data-action="close-setup" class="text-button setup-cancel">Cancel</button>
      <button type="button" data-action="setup-back" class="secondary-action setup-back">Back</button>
      <button type="button" data-action="setup-next" class="primary-action setup-next">Continue ${icon("arrow")}</button>
      <button type="submit" class="primary-action setup-submit">Create draft room</button>
    </div>
  </form>`;
}

function visualTieConfirmation() {
  const teams = pendingVisualTie.teamIds
    .map((teamId) => state.teams.find((team) => team.id === teamId))
    .filter(Boolean);
  const fromPhones = pendingVisualTie.source === "phone";
  return `<div class="visual-tie-confirmation">
    <div>${icon(fromPhones ? "phone" : "cards")}<span><small>${fromPhones ? "SIMULTANEOUS PHONE BIDS" : "SIMULTANEOUS CARDS"} · AUCTION PAUSED</small><strong>$${pendingVisualTie.amount} between ${escapeHtml(teams.map((team) => team.manager).join(", "))}</strong></span></div>
    <p>${fromPhones ? "Both bids landed inside the 300 ms tie window. The auctioneer can award the bid without guessing from network order." : "Tied managers: lower your cards, then raise again."}</p>
    <div class="visual-tie-actions">
      ${teams.map((team) => `<button data-action="resolve-visual-tie" data-team-id="${team.id}"><i style="background:${team.color}"></i>Award ${escapeHtml(team.manager)}</button>`).join("")}
      <button class="reject" data-action="cancel-visual-tie">Cancel</button>
    </div>
  </div>`;
}

function wireGlobalEvents() {
  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    try {
      if (action === "setup") {
        setupStep = 1;
        showSetupStep(1);
        return document.querySelector("#setup-dialog")?.showModal();
      }
      if (action === "close-setup") return document.querySelector("#setup-dialog")?.close();
      if (action === "setup-next") {
        if (!validateSetupStep(setupStep)) return;
        return showSetupStep(Math.min(3, setupStep + 1));
      }
      if (action === "setup-back") return showSetupStep(Math.max(1, setupStep - 1));
      if (action === "resolve-visual-tie") return resolveVisualTie(button.dataset.teamId);
      if (action === "cancel-visual-tie") return cancelVisualTie();
      if (action === "dismiss-notice") return showNotice(null);
      if (action === "focus-phone-room") return document.querySelector("#phone-room-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (action === "copy-phone-link") return copyPhoneJoinLink();
      if (action === "reset-phone-claims") return resetPhoneClaims();
      if (action === "voice") { voiceEnabled = !voiceEnabled; if (!voiceEnabled) stopAuctioneer(); render(); return; }
      if (action === "nominate") return update(nominatePlayer(state, button.dataset.playerId));
      if (action === "open") return beginAuction();
      if (action === "pause") { clearTimer(); stopAuctioneer(); return update(pauseAuction(state)); }
      if (action === "advance") return runCountdownStep(true);
      if (action === "next") return update(moveToNextPlayer(state));
      if (action === "bid") return submitBid(button.dataset.teamId);
      if (action === "undo") { clearTimer(); return update(undoLastSale(state), "Last sale reversed."); }
      if (action === "load-fantasy-pros") return loadFantasyProsPreset();
      if (action === "import") return document.querySelector("#csv-input")?.click();
    } catch (error) {
      showNotice({ kind: "error", message: error.message });
    }
  });

  app.addEventListener("change", (event) => {
    if (event.target.id === "auto-toggle") {
      autoEnabled = event.target.checked;
      if (autoEnabled && ["open", "once", "twice"].includes(state.auction.phase)) scheduleCountdown();
      else clearTimer();
    }
    if (event.target.id === "csv-input") importCsv(event.target.files?.[0]);
  });

  app.addEventListener("input", (event) => {
    if (event.target.id !== "player-search") return;
    renderSearchResults(event.target.value);
  });

  app.addEventListener("submit", (event) => {
    if (event.target.id !== "setup-form") return;
    event.preventDefault();
    const data = new FormData(event.target);
    const teamCount = Number(data.get("teamCount"));
    const budget = Number(data.get("budget"));
    const increment = Number(data.get("increment"));
    const rosterRequirements = Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Number(data.get(`position_${position}`)) || 0]));
    const benchSlots = Number(data.get("benchSlots")) || 0;
    const rosterSize = Object.values(rosterRequirements).reduce((sum, value) => sum + value, benchSlots);
    if (rosterSize < 1) return showNotice({ kind: "error", message: "Add at least one starting or bench roster slot." });
    const teamLines = String(data.get("teamNames") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const teams = makeTeams(teamCount, budget).map((team, index) => {
      const [name, manager] = (teamLines[index] || "").split("|").map((part) => part?.trim());
      return { ...team, name: name || team.name, manager: manager || team.manager };
    });
    const players = state.players.map((player) => ({ ...player, status: "available" }));
    state = createDraft({
      players,
      teams,
      budget,
      rosterSize,
      increment,
      rosterRequirements,
      nominationOrder: teams.map((team) => team.id)
    });
    clearVisualBidWindow();
    pendingVisualTie = null;
    persistDraft();
    document.querySelector("#setup-dialog")?.close();
    render();
    void initializePhoneRoom();
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea")) return;
    const teamIndex = Number(event.key) - 1;
    if (teamIndex >= 0 && teamIndex < Math.min(9, state.teams.length)) {
      submitBid(state.teams[teamIndex].id);
    }
    if (event.code === "Space" && ["open", "once", "twice"].includes(state.auction.phase)) {
      event.preventDefault();
      runCountdownStep(true);
    }
  });
}

function beginAuction() {
  clearTimer();
  clearVisualBidWindow();
  pendingVisualTie = null;
  state = openAuction(state);
  persistDraft();
  render();
  const player = currentPlayer(state);
  speak(auctioneerScript.nomination(player), scheduleCountdown, { style: "nomination", priority: SPEECH_PRIORITY.nomination });
}

function submitBid(teamId, bidAmount = null, { source = "manual" } = {}) {
  const input = document.querySelector("#manual-amount");
  const amount = bidAmount ?? (input ? Number(input.value) : null);
  clearTimer();
  clearVisualBidWindow();
  pendingVisualTie = null;
  state = placeBid(state, teamId, amount);
  persistDraft();
  render();
  const team = state.teams.find((item) => item.id === teamId);
  const next = state.auction.amount + state.config.increment;
  speak(auctioneerScript.bid({ amount: state.auction.amount, manager: team.manager, nextAmount: next, source }), scheduleCountdown, {
    style: "bid",
    priority: SPEECH_PRIORITY.bid
  });
}

function runCountdownStep(force = false) {
  if (!force && (pendingVisualTie || visualBidWindow)) return;
  clearTimer();
  const before = state.auction.phase;
  state = advanceCountdown(state);
  persistDraft();
  render();
  if (state.auction.phase === "once") speak(auctioneerScript.goingOnce(state.auction.amount), scheduleCountdown, { style: "countdown", priority: SPEECH_PRIORITY.countdown });
  else if (state.auction.phase === "twice") speak(auctioneerScript.goingTwice(state.auction.amount), scheduleCountdown, { style: "countdown", priority: SPEECH_PRIORITY.countdown });
  else if (state.auction.phase === "sold") {
    const player = currentPlayer(state);
    const team = state.teams.find((item) => item.id === state.auction.highBidderId);
    speak(auctioneerScript.sold({ player, team, amount: state.auction.amount }), null, { style: "sold", priority: SPEECH_PRIORITY.sold });
  } else if (state.auction.phase === "passed" && before === "open") {
    speak(auctioneerScript.passed(currentPlayer(state)), null, { style: "passed", priority: SPEECH_PRIORITY.sold });
  }
}

function scheduleCountdown() {
  clearTimer();
  if (!autoEnabled || pendingVisualTie || visualBidWindow || !["open", "once", "twice"].includes(state.auction.phase)) return;
  const delay = COUNTDOWN_DELAYS[state.auction.phase];
  countdownTimer = window.setTimeout(runCountdownStep, delay);
}

function clearTimer() {
  if (countdownTimer) window.clearTimeout(countdownTimer);
  countdownTimer = null;
}

function speak(text, onDone, { style = "neutral", priority = 0 } = {}) {
  if (!voiceEnabled) { onDone?.(); return; }
  auctioneerVoice.speak(text, {
    style,
    priority,
    onDone
  });
}

function stopAuctioneer() {
  auctioneerVoice.cancel();
}

function handlePhoneBid(bid) {
  if (!bid?.teamId || !["open", "once", "twice"].includes(state.auction.phase)) return;
  if (visualBidWindow && !bidsShareWindow(visualBidWindow.openedAt, bid.receivedAt)) resolveVisualBidWindow();
  collectExternalBids([{ teamId: bid.teamId, amount: bid.amount }], "phone", bid.receivedAt);
}

function collectExternalBids(bids, source, receivedAt = Date.now()) {
  const allowedTeamIds = pendingVisualTie ? new Set(pendingVisualTie.teamIds) : null;
  const eligibleBids = bids
    .map((bid) => ({ teamId: bid?.teamId, amount: Number(bid?.amount) }))
    .filter((bid) => bid.teamId && (!allowedTeamIds || allowedTeamIds.has(bid.teamId)))
    .filter((bid) => canPlaceVisualBid(bid.teamId, bid.amount));

  if (!eligibleBids.length) return;
  clearTimer();
  if (!visualBidWindow) {
    visualBidWindow = {
      bids: new Map(),
      source,
      openedAt: receivedAt,
      runoffRound: pendingVisualTie?.round || 0,
      timer: window.setTimeout(resolveVisualBidWindow, VISUAL_BID_WINDOW_MS)
    };
  }
  for (const bid of eligibleBids) {
    const existing = visualBidWindow.bids.get(bid.teamId);
    if (!existing || bid.amount > existing.amount) visualBidWindow.bids.set(bid.teamId, bid);
  }
}

function resolveVisualBidWindow() {
  const batch = visualBidWindow;
  visualBidWindow = null;
  if (!batch || !["open", "once", "twice"].includes(state.auction.phase)) return;
  const bids = [...batch.bids.values()].filter((bid) => canPlaceVisualBid(bid.teamId, bid.amount));
  const result = classifyPhoneBidBatch(bids);
  if (result.kind === "none") {
    pendingVisualTie = null;
    render();
    scheduleCountdown();
    return;
  }
  if (result.kind === "bid") {
    try { submitBid(result.teamId, result.amount, { source: batch.source }); }
    catch (error) { showNotice({ kind: "error", message: error.message }); scheduleCountdown(); }
    return;
  }

  pendingVisualTie = {
    teamIds: result.teamIds,
    amount: result.amount,
    source: batch.source,
    round: batch.runoffRound + 1
  };
  render();
  schedulePhoneRoomSync();
  const managers = result.teamIds
    .map((teamId) => state.teams.find((team) => team.id === teamId)?.manager)
    .filter(Boolean)
    .join(" and ");
  speak(auctioneerScript.simultaneous({ amount: result.amount, managers }), null, { style: "ruling", priority: SPEECH_PRIORITY.ruling });
}

function canPlaceVisualBid(teamId, amount) {
  const team = state.teams.find((item) => item.id === teamId);
  return Boolean(
    team
    && ["open", "once", "twice"].includes(state.auction.phase)
    && state.auction.highBidderId !== teamId
    && team.roster.length < state.config.rosterSize
    && canTeamRosterPlayer(state, teamId, state.auction.playerId)
    && amount >= nextVisualBidAmount(state)
    && amount <= maxBidForTeam(state, teamId)
  );
}

function resolveVisualTie(teamId) {
  if (!pendingVisualTie?.teamIds.includes(teamId)) return;
  const amount = pendingVisualTie.amount;
  try { submitBid(teamId, amount, { source: pendingVisualTie.source }); }
  catch (error) { showNotice({ kind: "error", message: error.message }); scheduleCountdown(); }
}

function cancelVisualTie() {
  clearVisualBidWindow();
  pendingVisualTie = null;
  render();
  scheduleCountdown();
}

function clearVisualBidWindow() {
  if (visualBidWindow?.timer) window.clearTimeout(visualBidWindow.timer);
  visualBidWindow = null;
}

async function initializePhoneRoom() {
  phoneRoom.status = "starting";
  phoneRoom.error = null;
  localStorage.setItem(PHONE_ROOM_ID_STORAGE_KEY, phoneRoom.roomId);
  localStorage.setItem(PHONE_ROOM_HOST_KEY_STORAGE_KEY, phoneRoom.hostKey);
  render();
  try {
    const snapshot = await postPhoneJson("/api/phone-room/upsert", {
      roomId: phoneRoom.roomId,
      hostKey: phoneRoom.hostKey,
      teams: state.teams.map((team) => ({ id: team.id, name: team.name, manager: team.manager, color: team.color }))
    });
    applyPhoneRoomSnapshot(snapshot);
    connectPhoneRoomEvents();
    phoneRoom.status = "live";
    render();
    await syncPhoneRoomState();
  } catch (error) {
    phoneRoom.status = "error";
    phoneRoom.error = error.message;
    render();
  }
}

function connectPhoneRoomEvents() {
  phoneRoomEvents?.close();
  phoneRoomEvents = new EventSource(`/api/phone-room/events?room=${encodeURIComponent(phoneRoom.roomId)}`);
  for (const eventName of ["snapshot", "room", "state"]) {
    phoneRoomEvents.addEventListener(eventName, (event) => {
      const payload = JSON.parse(event.data);
      applyPhoneRoomSnapshot(payload.room, { renderIfChanged: true });
    });
  }
  phoneRoomEvents.addEventListener("bid", (event) => handlePhoneBid(JSON.parse(event.data)));
  phoneRoomEvents.onopen = () => {
    if (phoneRoom.status !== "live") { phoneRoom.status = "live"; phoneRoom.error = null; render(); }
  };
  phoneRoomEvents.onerror = () => {
    if (phoneRoom.status !== "reconnecting") { phoneRoom.status = "reconnecting"; render(); }
  };
}

function applyPhoneRoomSnapshot(snapshot, { renderIfChanged = false } = {}) {
  if (!snapshot) return;
  const claimedTeamIds = (snapshot.teams || []).filter((team) => team.claimed).map((team) => team.id);
  const changed = claimedTeamIds.join(",") !== phoneRoom.claimedTeamIds.join(",")
    || Boolean(snapshot.joinUrl && snapshot.joinUrl !== phoneRoom.joinUrl);
  phoneRoom.joinUrl = snapshot.joinUrl || phoneRoom.joinUrl;
  phoneRoom.claimedTeamIds = claimedTeamIds;
  if (renderIfChanged && changed) render();
}

function schedulePhoneRoomSync() {
  if (!phoneRoom.joinUrl || phoneRoom.status === "starting" || phoneRoom.status === "error") return;
  if (phoneRoomSyncTimer) window.clearTimeout(phoneRoomSyncTimer);
  phoneRoomSyncTimer = window.setTimeout(() => void syncPhoneRoomState(), 25);
}

async function syncPhoneRoomState() {
  if (!phoneRoom.joinUrl) return;
  if (phoneRoomSyncTimer) window.clearTimeout(phoneRoomSyncTimer);
  phoneRoomSyncTimer = null;
  const player = currentPlayer(state);
  try {
    await postPhoneJson("/api/phone-room/state", {
      roomId: phoneRoom.roomId,
      hostKey: phoneRoom.hostKey,
      auction: {
        phase: state.auction.phase,
        amount: state.auction.amount,
        nextBid: nextVisualBidAmount(state),
        highBidderId: state.auction.highBidderId,
        acceptingBids: ["open", "once", "twice"].includes(state.auction.phase) && !pendingVisualTie,
        player: player ? { id: player.id, name: player.name, position: player.position, nflTeam: player.nflTeam, suggestedValue: player.suggestedValue } : null
      },
      teams: state.teams.map((team) => ({
        id: team.id,
        budget: team.budget,
        rosterCount: team.roster.length,
        rosterSize: state.config.rosterSize,
        eligibleForPlayer: !player || canTeamRosterPlayer(state, team.id, player.id),
        maxBid: maxBidForTeam(state, team.id),
        roster: team.roster.map((spot) => {
          const rosterPlayer = state.players.find((item) => item.id === spot.playerId);
          return {
            playerId: spot.playerId,
            name: rosterPlayer?.name || "Unknown player",
            position: rosterPlayer?.position || "FLEX",
            nflTeam: rosterPlayer?.nflTeam || "FA",
            price: spot.price
          };
        })
      }))
    });
  } catch (error) {
    phoneRoom.status = "reconnecting";
    phoneRoom.error = error.message;
    render();
  }
}

async function copyPhoneJoinLink() {
  if (!phoneRoom.joinUrl) return;
  try {
    await navigator.clipboard.writeText(phoneRoom.joinUrl);
    showNotice({ kind: "success", message: "Phone join link copied." });
  } catch {
    window.prompt("Copy this phone join link:", phoneRoom.joinUrl);
  }
}

async function resetPhoneClaims() {
  const snapshot = await postPhoneJson("/api/phone-room/reset-claims", { roomId: phoneRoom.roomId, hostKey: phoneRoom.hostKey });
  applyPhoneRoomSnapshot(snapshot);
  render();
  showNotice({ kind: "success", message: "All phones were disconnected from their teams." });
}

async function postPhoneJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The phone bidding room is unavailable.");
  return payload;
}

function renderSearchResults(query) {
  const container = document.querySelector("#search-results");
  if (!container) return;
  const value = query.trim().toLowerCase();
  if (!value) { container.innerHTML = ""; return; }
  const matches = state.players.filter((player) => player.status === "available" && `${player.name} ${player.position} ${player.nflTeam}`.toLowerCase().includes(value)).slice(0, 6);
  container.innerHTML = matches.map((player) => `<button data-action="nominate" data-player-id="${player.id}"><span>${escapeHtml(player.name)} <small>${player.position} · ${player.nflTeam}</small></span><b>Nominate</b></button>`).join("") || `<p>No available player found.</p>`;
}

async function importCsv(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines.shift().split(",").map((item) => item.trim().toLowerCase());
    const column = (name) => header.indexOf(name);
    if (column("name") < 0 || column("position") < 0) throw new Error("CSV needs name and position columns.");
    const imported = lines.map((line, index) => {
      const cells = line.split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
      const name = cells[column("name")];
      return {
        id: `import-${slug(name)}-${index}`,
        name,
        position: cells[column("position")]?.toUpperCase() || "FLEX",
        nflTeam: cells[column("team")]?.toUpperCase() || "FA",
        suggestedValue: Number(cells[column("value")]) || 1,
        status: "available"
      };
    }).filter((player) => player.name);
    state = createDraft({
      players: imported,
      teams: state.teams.map((team) => ({ ...team, roster: [] })),
      budget: state.config.budget,
      rosterSize: state.config.rosterSize,
      increment: state.config.increment,
      rosterRequirements: normalizedRequirements(),
      nominationOrder: state.nomination?.order
    });
    persistDraft();
    render();
    showNotice({ kind: "success", message: `Imported ${imported.length} players and reset the draft.` });
  } catch (error) { showNotice({ kind: "error", message: error.message }); }
}

function loadFantasyProsPreset() {
  clearTimer();
  stopAuctioneer();
  clearVisualBidWindow();
  pendingVisualTie = null;
  state = createDraft({
    players: fantasyProsPlayers,
    teams: state.teams.map((team) => ({ ...team, roster: [] })),
    budget: state.config.budget,
    rosterSize: state.config.rosterSize,
    increment: state.config.increment,
    rosterRequirements: normalizedRequirements(),
    nominationOrder: state.nomination?.order
  });
  persistDraft();
  render();
  showNotice({ kind: "success", message: `Loaded ${fantasyProsPlayers.length} FantasyPros players and auction values. The draft is ready.` });
}

function update(nextState, message) {
  state = nextState;
  persistDraft();
  render();
  if (message) showNotice({ kind: "success", message });
}

function showNotice(nextNotice) {
  notice = nextNotice;
  render();
  if (notice) window.setTimeout(() => { if (notice === nextNotice) { notice = null; render(); } }, 4500);
}

function persistDraft() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  schedulePhoneRoomSync();
}

function phoneRoomStatusLabel() {
  if (phoneRoom.status === "live") return "LIVE";
  if (phoneRoom.status === "reconnecting") return "RECONNECTING";
  if (phoneRoom.status === "error") return "ROOM ERROR";
  return "STARTING";
}

function qrCodeSvg(text) {
  const QrCode = globalThis.qrcodegen?.QrCode;
  if (!QrCode || !text) return "";
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const border = 3;
  const size = qr.size + border * 2;
  let path = "";
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.getModule(x, y)) path += `M${x + border},${y + border}h1v1h-1z`;
    }
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code for room ${escapeHtml(phoneRoom.roomId)}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff9ed"/><path d="${path}" fill="#17130e"/></svg>`;
}

function auctioneerVoiceTitle() {
  if (!voiceEnabled) return "Turn on auctioneer voice";
  if (auctioneerService.status === "ready" && auctioneerService.available) return `Cartesia ${auctioneerService.model} auctioneer is on`;
  return "Auctioneer voice is on with browser fallback";
}

function restoreDraft() {
  try {
    const restored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!restored) return null;
    restored.config = {
      ...restored.config,
      rosterRequirements: Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Number(restored.config?.rosterRequirements?.[position]) || 0]))
    };
    restored.nomination ||= { order: restored.teams.map((team) => team.id), currentIndex: 0 };
    restored.auction = { nominatorTeamId: null, ...restored.auction };
    return restored;
  } catch { return null; }
}

function normalizedRequirements() {
  return Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Number(state.config.rosterRequirements?.[position]) || 0]));
}

function orderedTeamsForSetup() {
  const byId = new Map(state.teams.map((team) => [team.id, team]));
  const ordered = (state.nomination?.order || []).map((id) => byId.get(id)).filter(Boolean);
  return [...ordered, ...state.teams.filter((team) => !ordered.includes(team))];
}

function validateSetupStep(step) {
  const section = document.querySelector(`[data-setup-step="${step}"]`);
  const invalid = [...(section?.querySelectorAll("input, textarea") || [])].find((input) => !input.checkValidity());
  invalid?.reportValidity();
  return !invalid;
}

function showSetupStep(step) {
  setupStep = step;
  document.querySelectorAll("[data-setup-step]").forEach((section) => section.classList.toggle("is-active", Number(section.dataset.setupStep) === step));
  document.querySelectorAll("[data-progress-step]").forEach((item) => {
    const itemStep = Number(item.dataset.progressStep);
    item.classList.toggle("is-active", itemStep === step);
    item.classList.toggle("is-done", itemStep < step);
    const marker = item.querySelector("i");
    if (marker) marker.textContent = itemStep < step ? "✓" : String(itemStep);
  });
  document.querySelector(".setup-back")?.toggleAttribute("hidden", step === 1);
  document.querySelector(".setup-next")?.toggleAttribute("hidden", step === 3);
  document.querySelector(".setup-submit")?.toggleAttribute("hidden", step !== 3);
}

function phaseLabel(phase) {
  return ({ idle: "Room ready", ready: "Player nominated", open: "Bidding live", once: "Going once", twice: "Going twice", paused: "Auction paused", sold: "Player sold", passed: "No sale" })[phase] || phase;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function createHostKey() {
  return (crypto.randomUUID?.() || `host_${Date.now()}_${Math.random().toString(36).slice(2)}`).replaceAll("-", "_");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function icon(name) {
  const paths = {
    phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 5h4M11 18h2"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    camera: '<path d="M14.5 5 13 3H7L5.5 5H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-6.5Z"/><circle cx="10" cy="12" r="4"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    upload: '<path d="M12 16V3m0 0L7 8m5-5 5 5M4 14v6h16v-6"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
    expand: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="m3 8 6-6m12 6-6-6M3 16l6 6m12-6-6 6"/>',
    cards: '<rect x="3" y="4" width="14" height="16" rx="2"/><path d="m17 7 3 .7a2 2 0 0 1 1.5 2.4l-2 8a2 2 0 0 1-2.4 1.5"/><path d="M7 9h6M7 13h6"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'
  };
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function sunLogo() {
  return `<svg class="sun-logo" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <g stroke="currentColor" stroke-width="3" stroke-linecap="round">
      <path d="M32 3v8M32 53v8M3 32h8M53 32h8M11.5 11.5l5.7 5.7M46.8 46.8l5.7 5.7M52.5 11.5l-5.7 5.7M17.2 46.8l-5.7 5.7"/>
    </g>
    <circle cx="32" cy="32" r="16.5" fill="#dba52e" stroke="currentColor" stroke-width="3"/>
    <path d="M24.5 29c2-2 4-2 6 0M33.5 29c2-2 4-2 6 0M26 38c3.7 2.7 8.3 2.7 12 0" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`;
}
