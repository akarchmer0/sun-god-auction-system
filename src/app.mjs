import { seedPlayers, makeTeams, parseTeamSetupLines } from "./data.mjs";
import { fantasyProsPlayers } from "./fantasy-pros-data.mjs";
import { AuctioneerVoice } from "./auctioneer-voice.mjs";
import { createAuctioneerScript, AUCTIONEER_PERSONALITIES } from "./auctioneer-script.mjs";
import {
  buildPatterPassage,
  isLiveAuctionPhase,
  LOCAL_PATTER_PASSAGE_LINES,
  patterDelayMs
} from "./auctioneer-patter.mjs";
import { shouldRoastSale } from "./roast-engine.mjs";
import { classifyPhoneBidBatch } from "./phone-bidding.mjs";
import {
  parseCsv,
  suggestCsvMapping,
  playersFromMappedCsv,
  buildResultsPayload,
  encodeResultsPayload
} from "./draft-io.mjs";
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
import {
  autoBidDelayMs,
  autoTeamController,
  buildAutoIntentContext,
  chooseAutoBid,
  chooseAutoNomination,
  isAutoTeam,
  localAutoIntents,
  normalizeAutoIntents
} from "./autodraft.mjs";

const STORAGE_KEY = "gavel-draft-v1";
const PHONE_ROOM_ID_STORAGE_KEY = "sun-god-phone-room-id";
const PHONE_ROOM_HOST_KEY_STORAGE_KEY = "sun-god-phone-room-host-key";
const AUCTIONEER_PROFILE_STORAGE_KEY = "sun-god-auctioneer-profile-v1";
const COUNTDOWN_DELAYS = { open: 8000, once: 5200, twice: 4200 };
const SPEECH_PRIORITY = { patter: 20, nomination: 30, countdown: 50, bid: 100, roast: 105, sold: 110, ruling: 120, preflight: 130 };
const STANDARD_ROSTER_REQUIREMENTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };
const app = document.querySelector("#app");
let state = restoreDraft() || createDraft({
  players: seedPlayers,
  teams: makeTeams(),
  budget: 200,
  rosterSize: 15,
  rosterRequirements: STANDARD_ROSTER_REQUIREMENTS
});
let auctioneerProfile = restoreAuctioneerProfile();
let voiceEnabled = auctioneerProfile.enabled;
let recentRoasts = [];
let autoEnabled = true;
let setupStep = 1;
let pendingCsvImport = null;
let countdownTimer = null;
let autoDraftTimer = null;
let autoIntentRequestSequence = 0;
let patterTimer = null;
let patterSequence = 0;
let patterQueue = [];
let patterQueueKey = "";
let patterRequest = null;
let patterRequestSequence = 0;
let recentPatterLines = [];
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
  provider: "browser",
  requestedProvider: auctioneerProfile.provider,
  providers: {},
  model: null,
  voiceId: null,
  message: "Checking Cartesia's realtime auctioneer."
};
let auctioneerScript = createAuctioneerScript(auctioneerProfile);
const auctioneerVoice = new AuctioneerVoice({
  provider: auctioneerProfile.provider,
  onStatusChange: (snapshot) => {
    const changed = snapshot.status !== auctioneerService.status
      || snapshot.available !== auctioneerService.available
      || snapshot.provider !== auctioneerService.provider
      || snapshot.message !== auctioneerService.message
      || snapshot.patter?.message !== auctioneerService.patter?.message
      || snapshot.roasting?.message !== auctioneerService.roasting?.message;
    auctioneerService = snapshot;
    if (changed) {
      if (document.querySelector("#audio-dialog")?.open) updateAudioServiceStatus();
      else render();
    }
  }
});
render();
wireGlobalEvents();
void auctioneerVoice.initialize(auctioneerProfile.provider);
void initializePhoneRoom();
if (state.auction.phase === "ready") void prepareAutoIntents();
else if (isLiveAuctionPhase(state.auction.phase)) { freezeLocalAutoIntents(); resumeAuctionFlow(); }
else scheduleAutoNomination();

function render() {
  const player = currentPlayer(state);
  const highBidder = state.teams.find((team) => team.id === state.auction.highBidderId);
  const nextNominator = currentNominator(state);
  const lotNominator = state.teams.find((team) => team.id === state.auction.nominatorTeamId) || nextNominator;
  const available = state.players.filter((item) => item.status === "available");
  const humanTeamCount = state.teams.filter((team) => !isAutoTeam(team)).length;
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
          <button class="device-button ${phoneRoom.status === "live" ? "is-on" : ""}" data-action="focus-phone-room" title="Show phone bidding room">${icon("phone")} <span>${phoneRoom.claimedTeamIds.length}/${humanTeamCount} phones</span></button>
          <button class="icon-button ${voiceEnabled ? "is-on" : ""}" data-action="audio-settings" title="${escapeHtml(auctioneerVoiceTitle())}">${icon("volume")}</button>
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
          <div class="phone-claim-summary"><span>PARTICIPANTS</span><strong>${phoneRoom.claimedTeamIds.length}/${humanTeamCount} joined</strong></div>
          <div class="phone-claim-grid">
            ${state.teams.map((team) => {
              const joined = phoneRoom.claimedTeamIds.includes(team.id);
              const automatic = isAutoTeam(team);
              return `<div class="phone-claim ${joined || automatic ? "is-joined" : ""} ${automatic ? "is-auto" : ""}"><i style="background:${team.color}"></i><span><strong>${escapeHtml(team.manager)}</strong><small>${automatic ? "AUTO DRAFT" : joined ? "PHONE READY" : "WAITING"}</small></span>${icon(automatic ? "settings" : joined ? "check" : "phone")}</div>`;
            }).join("")}
          </div>
          <p class="camera-note">Human managers scan once and choose their team. Auto teams make one strategic intent decision per nomination, then bid locally within the league rules.</p>
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
            <div class="ledger-tools"><button class="text-button" data-action="results">Results</button><button class="text-button" data-action="undo" ${state.sales.length ? "" : "disabled"}>Undo last</button></div>
          </div>
          <div class="sales-list">
            ${state.sales.length ? [...state.sales].reverse().slice(0, 5).map(saleRow).join("") : `<p class="empty-copy">Every completed sale will appear here.</p>`}
          </div>
          <button class="draft-results-button" data-action="results">${icon("trophy")}<span><strong>View & export results</strong><small>Summary · CSV · ESPN · Yahoo · Sleeper</small></span>${icon("arrow")}</button>
        </aside>
      </main>
    </div>
    <dialog id="setup-dialog">${setupDialog()}</dialog>
    <dialog id="csv-mapping-dialog">${pendingCsvImport ? csvMappingDialog() : ""}</dialog>
    <dialog id="audio-dialog">${audioDialog()}</dialog>
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
  const automatic = isAutoTeam(team);
  const autoDecision = state.auction.autoIntents?.[team.id];
  const autoLabel = state.auction.autoIntentStatus === "pending"
    ? "AUTO · THINKING"
    : autoDecision?.intent ? `AUTO · ${autoDecision.intent.toUpperCase()}` : "AUTO";
  const legalRosterFit = !state.auction.playerId || canTeamRosterPlayer(state, team.id, state.auction.playerId);
  const disabled = !["open", "once", "twice"].includes(state.auction.phase) || isHigh || !legalRosterFit || maxBid < Math.max(1, state.auction.amount + state.config.increment);
  const title = !legalRosterFit ? "This player would prevent the team from completing its required positions." : "";
  return `<button class="team-bid ${isHigh ? "is-high" : ""}" style="--team:${team.color}" data-action="bid" data-team-id="${team.id}" title="${escapeHtml(title)}" ${disabled ? "disabled" : ""}>
    <span class="team-key" title="Keyboard shortcut ${index < 9 ? index + 1 : "unassigned"}">${index < 9 ? index + 1 : ""}</span>
    <span class="team-swatch"></span>
    <span class="team-copy"><strong>${escapeHtml(team.name)}</strong><small>${escapeHtml(team.manager)} · ${team.roster.length}/${state.config.rosterSize} players</small></span>
    <span class="team-money"><strong>$${team.budget}</strong><small>max $${maxBid}</small></span>
    <span class="armed-label">${isHigh ? "HIGH BID" : "+ BID"}</span>
    <span class="phone-bid-badge ${automatic ? "is-auto" : ""}" title="${automatic ? escapeHtml(autoDecision ? `${autoDecision.provider === "openai" ? "AI" : "Local"} strategy: ${autoDecision.reason.replaceAll("_", " ")}` : "AI strategy with local rules-based bidding") : phoneJoined ? "Phone connected" : "Waiting for phone"}">${automatic ? autoLabel : phoneJoined ? "PHONE READY" : "NO PHONE"}</span>
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
      <fieldset class="autodraft-team-fieldset"><legend>AUTO DRAFT CONTROL</legend><p>Marked teams cannot be claimed by a phone. AI chooses pass, value, or target once per nomination; local rules place every bid.</p>
        <div class="autodraft-team-grid">
          ${Array.from({ length: 12 }, (_, index) => {
            const team = orderedTeams[index];
            return `<label data-auto-team-slot="${index}" ${index >= state.teams.length ? "hidden" : ""}><input type="checkbox" name="autoTeam_${index}" ${isAutoTeam(team) ? "checked" : ""} /><i></i><span><strong data-auto-team-label>${escapeHtml(team?.manager || `Manager ${index + 1}`)}</strong><small>${escapeHtml(team?.name || `Team ${index + 1}`)}</small></span><b>AUTO</b></label>`;
          }).join("")}
        </div>
      </fieldset>
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

function csvMappingDialog() {
  const { fileName, headers, rows, mapping } = pendingCsvImport;
  const fields = [
    ["name", "Player name", true],
    ["position", "Position", true],
    ["team", "NFL team", false],
    ["value", "Suggested value", false]
  ];
  const previewHeaders = headers.slice(0, 6);
  return `<form id="csv-mapping-form" method="dialog">
    <div class="dialog-head"><div><span class="eyebrow">PLAYER CSV IMPORT</span><h2>Map your columns</h2></div><button type="button" data-action="close-import" class="dialog-close" aria-label="Close">×</button></div>
    <p><strong>${escapeHtml(fileName)}</strong> contains ${rows.length} data row${rows.length === 1 ? "" : "s"}. Match its headings before resetting the current draft.</p>
    <div class="csv-mapping-grid">
      ${fields.map(([field, label, required]) => `<label><span>${label}${required ? " *" : ""}</span><select name="map_${field}" ${required ? "required" : ""}>
        <option value="">${required ? "Choose a column" : "Do not import"}</option>
        ${headers.map((header, index) => `<option value="${index}" ${mapping[field] === index ? "selected" : ""}>${escapeHtml(header)}</option>`).join("")}
      </select></label>`).join("")}
    </div>
    <div class="csv-preview-wrap"><span>FILE PREVIEW</span><table><thead><tr>${previewHeaders.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>
      ${rows.slice(0, 3).map((row) => `<tr>${previewHeaders.map((_, index) => `<td>${escapeHtml(row[index] || "")}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>
    <div class="import-warning">Importing replaces the player pool and clears every sale and roster. League rules and nomination order stay intact.</div>
    <div class="csv-form-error" role="alert" hidden></div>
    <div class="dialog-actions"><button type="button" data-action="close-import" class="secondary-action">Cancel</button><button type="submit" class="primary-action">Import players & reset</button></div>
  </form>`;
}

function audioDialog() {
  const providerOptions = [
    ["auto", "Auto", "ElevenLabs first, then Cartesia"],
    ["elevenlabs", "ElevenLabs", providerOptionCopy("elevenlabs")],
    ["cartesia", "Cartesia Lucy", providerOptionCopy("cartesia")]
  ];
  return `<form id="audio-form" method="dialog">
    <div class="dialog-head"><div><span class="eyebrow">AUCTIONEER AUDIO</span><h2>Lucy’s booth</h2></div><button type="button" data-action="close-audio" class="dialog-close" aria-label="Close">×</button></div>
    <div class="audio-provider-card ${auctioneerService.provider === "browser" ? "is-fallback" : ""}">
      <span class="audio-provider-icon">${icon("volume")}</span>
      <span><small data-audio-provider-label>${escapeHtml(audioProviderLabel())}</small><strong data-audio-provider-message>${escapeHtml(auctioneerService.message)}</strong></span>
      <i></i>
    </div>
    <fieldset class="audio-fieldset provider-fieldset"><legend>VOICE PROVIDER</legend><div class="provider-grid">
      ${providerOptions.map(([id, name, copy]) => {
        const unavailable = id !== "auto" && auctioneerService.providers?.[id]?.available === false;
        return `<label class="provider-option ${unavailable ? "is-unavailable" : ""}"><input type="radio" name="provider" value="${id}" ${auctioneerProfile.provider === id ? "checked" : ""} ${unavailable ? "disabled" : ""} /><span><strong>${name}</strong><small>${escapeHtml(copy)}</small></span></label>`;
      }).join("")}
    </div></fieldset>
    <label class="audio-enabled-row"><span><strong>Auctioneer voice</strong><small>Keep announcements, countdowns, and rulings audible.</small></span><input name="enabled" type="checkbox" ${voiceEnabled ? "checked" : ""} /><b></b></label>
    <label class="audio-enabled-row play-by-play-row"><span><strong>Continuous play-by-play</strong><small data-patter-provider-message>${escapeHtml(patterDirectorLabel())} Bids wait for the current line; rulings interrupt.</small></span><input name="playByPlayEnabled" type="checkbox" ${auctioneerProfile.playByPlayEnabled ? "checked" : ""} /><b></b></label>
    <label class="audio-enabled-row roast-enabled-row"><span><strong>Dark fantasy roasts</strong><small data-roast-provider-message>${escapeHtml(roastWriterLabel())} Dark, vulgar jokes target bids and draft decisions—not protected traits.</small></span><input name="roastingEnabled" type="checkbox" ${auctioneerProfile.roastingEnabled ? "checked" : ""} /><b></b></label>
    <fieldset class="audio-fieldset"><legend>PERSONALITY</legend><div class="personality-grid">
      ${Object.entries(AUCTIONEER_PERSONALITIES).map(([id, profile]) => `<label class="personality-option"><input type="radio" name="personality" value="${id}" ${auctioneerProfile.personality === id ? "checked" : ""} /><span><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.description)}</small></span><i>✓</i></label>`).join("")}
    </div></fieldset>
    <fieldset class="audio-fieldset"><legend>ENERGY LEVEL</legend><div class="energy-grid">
      ${[[1, "Measured", "Calm pacing"], [2, "Draft night", "Balanced"], [3, "Full send", "Maximum lift"]].map(([value, name, copy]) => `<label><input type="radio" name="energy" value="${value}" ${auctioneerProfile.energy === value ? "checked" : ""} /><span><strong>${name}</strong><small>${copy}</small></span></label>`).join("")}
    </div></fieldset>
    <div class="audio-preflight"><span><small>ROOM CHECK</small><strong data-audio-check>Make sure every manager can hear the auctioneer.</strong></span><button type="button" data-action="test-audio">${icon("volume")} Can you hear Lucy?</button></div>
    <div class="audio-cache-note">${icon("database")} Common countdown calls are cached after first playback. If realtime audio stalls, Sun God automatically finishes with a browser voice.</div>
    <div class="dialog-actions"><button type="button" data-action="close-audio" class="secondary-action">Cancel</button><button type="submit" class="primary-action">Save audio settings</button></div>
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
    if (voiceEnabled) void auctioneerVoice.unlock();
    const action = button.dataset.action;
    try {
      if (action === "setup") {
        setupStep = 1;
        showSetupStep(1);
        return document.querySelector("#setup-dialog")?.showModal();
      }
      if (action === "close-setup") return document.querySelector("#setup-dialog")?.close();
      if (action === "close-import") {
        pendingCsvImport = null;
        return render();
      }
      if (action === "audio-settings") {
        clearPatter();
        document.querySelector("#audio-dialog")?.showModal();
        void auctioneerVoice.initialize(auctioneerProfile.provider);
        return;
      }
      if (action === "close-audio") {
        stopAuctioneer();
        void auctioneerVoice.setProvider(auctioneerProfile.provider);
        document.querySelector("#audio-dialog")?.close();
        return resumeAuctionFlow();
      }
      if (action === "test-audio") return runAudioPreflight(button);
      if (action === "setup-next") {
        if (!validateSetupStep(setupStep)) return;
        const nextStep = Math.min(3, setupStep + 1);
        showSetupStep(nextStep);
        if (nextStep === 3) syncAutodraftTeamSetup();
        return;
      }
      if (action === "setup-back") return showSetupStep(Math.max(1, setupStep - 1));
      if (action === "resolve-visual-tie") return resolveVisualTie(button.dataset.teamId);
      if (action === "cancel-visual-tie") return cancelVisualTie();
      if (action === "dismiss-notice") return showNotice(null);
      if (action === "focus-phone-room") return document.querySelector("#phone-room-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (action === "copy-phone-link") return copyPhoneJoinLink();
      if (action === "reset-phone-claims") return resetPhoneClaims();
      if (action === "nominate") return await selectNomination(button.dataset.playerId);
      if (action === "open") return beginAuction();
      if (action === "pause") { clearTimer(); clearAutoDraftTimer(); stopAuctioneer(); return update(pauseAuction(state)); }
      if (action === "advance") return runCountdownStep(true);
      if (action === "next") return await selectNextQueuedPlayer();
      if (action === "bid") return submitBid(button.dataset.teamId);
      if (action === "undo") {
        clearTimer();
        clearAutoDraftTimer();
        update(undoLastSale(state), "Last sale reversed.");
        return await prepareAutoIntents();
      }
      if (action === "results") return await openResultsPage();
      if (action === "load-fantasy-pros") return loadFantasyProsPreset();
      if (action === "import") return document.querySelector("#csv-input")?.click();
    } catch (error) {
      showNotice({ kind: "error", message: error.message });
    }
  });

  app.addEventListener("change", (event) => {
    if (event.target.id === "auto-toggle") {
      autoEnabled = event.target.checked;
      if (isLiveAuctionPhase(state.auction.phase)) resumeAuctionFlow();
      else clearTimer();
    }
    if (event.target.id === "csv-input") {
      void importCsv(event.target.files?.[0]);
      event.target.value = "";
    }
  });

  app.addEventListener("input", (event) => {
    if (event.target.id === "player-search") renderSearchResults(event.target.value);
    if (event.target.name === "teamCount" || event.target.name === "teamNames") syncAutodraftTeamSetup();
  });

  app.addEventListener("submit", (event) => {
    if (event.target.id === "audio-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      auctioneerProfile = {
        enabled: data.get("enabled") === "on",
        playByPlayEnabled: data.get("playByPlayEnabled") === "on",
        roastingEnabled: data.get("roastingEnabled") === "on",
        provider: ["auto", "elevenlabs", "cartesia"].includes(data.get("provider")) ? data.get("provider") : "auto",
        personality: AUCTIONEER_PERSONALITIES[data.get("personality")] ? data.get("personality") : "classic",
        energy: Math.min(3, Math.max(1, Number(data.get("energy")) || 2))
      };
      voiceEnabled = auctioneerProfile.enabled;
      auctioneerScript = createAuctioneerScript(auctioneerProfile);
      patterQueue = [];
      patterQueueKey = "";
      localStorage.setItem(AUCTIONEER_PROFILE_STORAGE_KEY, JSON.stringify(auctioneerProfile));
      void auctioneerVoice.setProvider(auctioneerProfile.provider);
      if (!voiceEnabled) stopAuctioneer();
      else if (!auctioneerProfile.playByPlayEnabled) clearPatter();
      document.querySelector("#audio-dialog")?.close();
      render();
      resumeAuctionFlow();
      showNotice({ kind: "success", message: `${AUCTIONEER_PERSONALITIES[auctioneerProfile.personality].name} is at energy ${auctioneerProfile.energy}; play-by-play ${auctioneerProfile.playByPlayEnabled ? "on" : "off"}, roasts ${auctioneerProfile.roastingEnabled ? "on" : "off"}.` });
      return;
    }
    if (event.target.id === "csv-mapping-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      try {
        const mapping = Object.fromEntries(["name", "position", "team", "value"].map((field) => {
          const value = data.get(`map_${field}`);
          return [field, value === "" ? -1 : Number(value)];
        }));
        const imported = playersFromMappedCsv(pendingCsvImport?.rows || [], mapping);
        clearTimer();
        clearAutoDraftTimer();
        stopAuctioneer();
        clearVisualBidWindow();
        pendingVisualTie = null;
        pendingCsvImport = null;
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
        scheduleAutoNomination();
        showNotice({ kind: "success", message: `Imported ${imported.length} players and reset the draft.` });
      } catch (error) {
        const errorNode = event.target.querySelector(".csv-form-error");
        if (errorNode) { errorNode.textContent = error.message; errorNode.hidden = false; }
      }
      return;
    }
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
    clearTimer();
    clearAutoDraftTimer();
    stopAuctioneer();
    const teamLines = parseTeamSetupLines(data.get("teamNames"));
    const teams = makeTeams(teamCount, budget).map((team, index) => {
      const { name, manager } = teamLines[index] || {};
      return {
        ...team,
        name: name || team.name,
        manager: manager || team.manager,
        controller: data.get(`autoTeam_${index}`) === "on"
          ? { type: "auto", strategy: "balanced", aggressiveness: 1 }
          : { type: "human", strategy: "balanced", aggressiveness: 1 }
      };
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
    scheduleAutoNomination();
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

async function selectNomination(playerId) {
  clearTimer();
  clearAutoDraftTimer();
  autoIntentRequestSequence += 1;
  update(nominatePlayer(state, playerId));
  return await prepareAutoIntents();
}

async function selectNextQueuedPlayer() {
  clearTimer();
  clearAutoDraftTimer();
  autoIntentRequestSequence += 1;
  update(moveToNextPlayer(state));
  return await prepareAutoIntents();
}

async function prepareAutoIntents() {
  if (state.auction.phase !== "ready" || !state.auction.playerId) return;
  const fallback = localAutoIntents(state);
  const teamIds = Object.keys(fallback);
  state = {
    ...state,
    auction: {
      ...state.auction,
      autoIntents: fallback,
      autoIntentStatus: teamIds.length ? "pending" : "ready"
    }
  };
  persistDraft();
  render();
  if (!teamIds.length) return;

  const requestId = ++autoIntentRequestSequence;
  const playerId = state.auction.playerId;
  try {
    const response = await fetch("/api/autodraft/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: buildAutoIntentContext(state),
        fallbackDecisions: Object.entries(fallback).map(([teamId, decision]) => ({ teamId, intent: decision.intent, reason: decision.reason }))
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "AI autodraft strategy is unavailable.");
    if (requestId !== autoIntentRequestSequence || state.auction.playerId !== playerId || state.auction.phase !== "ready") return;
    state = {
      ...state,
      auction: {
        ...state.auction,
        autoIntents: normalizeAutoIntents(state, payload.decisions, { provider: payload.provider, model: payload.model }),
        autoIntentStatus: "ready"
      }
    };
    persistDraft();
    render();
  } catch {
    if (requestId !== autoIntentRequestSequence || state.auction.playerId !== playerId || state.auction.phase !== "ready") return;
    state = { ...state, auction: { ...state.auction, autoIntentStatus: "ready" } };
    persistDraft();
    render();
  }
}

function freezeLocalAutoIntents() {
  if (!state.auction.playerId || state.auction.autoIntentStatus === "ready") return;
  autoIntentRequestSequence += 1;
  state = {
    ...state,
    auction: {
      ...state.auction,
      autoIntents: localAutoIntents(state),
      autoIntentStatus: "ready"
    }
  };
}

function scheduleAutoDraftBid() {
  clearAutoDraftTimer();
  if (pendingVisualTie || visualBidWindow) return;
  const decision = chooseAutoBid(state);
  if (!decision) return;
  autoDraftTimer = window.setTimeout(() => {
    autoDraftTimer = null;
    if (pendingVisualTie || visualBidWindow) return resumeAuctionFlow();
    const latest = chooseAutoBid(state);
    if (!latest) return;
    try { submitBid(latest.teamId, latest.amount, { source: "auto" }); }
    catch { resumeAuctionFlow(); }
  }, autoBidDelayMs(state, decision.teamId));
}

function scheduleAutoNomination() {
  clearAutoDraftTimer();
  if (!["idle", "sold", "passed"].includes(state.auction.phase)) return;
  const nominator = currentNominator(state);
  if (!nominator || !isAutoTeam(nominator)) return;
  const playerId = chooseAutoNomination(state, nominator.id);
  if (!playerId) return;
  autoDraftTimer = window.setTimeout(async () => {
    autoDraftTimer = null;
    const current = currentNominator(state);
    if (!["idle", "sold", "passed"].includes(state.auction.phase) || current?.id !== nominator.id) return;
    try {
      await selectNomination(playerId);
    } catch (error) {
      showNotice({ kind: "error", message: error.message });
    }
  }, 900);
}

function clearAutoDraftTimer() {
  if (autoDraftTimer) window.clearTimeout(autoDraftTimer);
  autoDraftTimer = null;
}

function beginAuction() {
  clearTimer();
  clearAutoDraftTimer();
  clearPatter();
  clearVisualBidWindow();
  pendingVisualTie = null;
  freezeLocalAutoIntents();
  state = openAuction(state);
  persistDraft();
  render();
  const player = currentPlayer(state);
  speak(auctioneerScript.nomination(player), null, { style: "nomination", priority: SPEECH_PRIORITY.nomination });
  resumeAuctionFlow();
}

function submitBid(teamId, bidAmount = null, { source = "manual" } = {}) {
  const input = document.querySelector("#manual-amount");
  const amount = bidAmount ?? (input ? Number(input.value) : null);
  clearTimer();
  clearAutoDraftTimer();
  clearPatter();
  clearVisualBidWindow();
  pendingVisualTie = null;
  state = placeBid(state, teamId, amount);
  persistDraft();
  render();
  const team = state.teams.find((item) => item.id === teamId);
  const next = state.auction.amount + state.config.increment;
  speak(auctioneerScript.bid({ amount: state.auction.amount, manager: team.manager, nextAmount: next, source }), null, {
    style: "bid",
    priority: SPEECH_PRIORITY.bid,
    interrupt: false,
    queueKey: "live-bid"
  });
  resumeAuctionFlow();
}

function runCountdownStep(force = false) {
  if (!force && (pendingVisualTie || visualBidWindow)) return;
  clearTimer();
  clearAutoDraftTimer();
  clearPatter();
  const before = state.auction.phase;
  state = advanceCountdown(state);
  persistDraft();
  render();
  if (state.auction.phase === "once") {
    speak(auctioneerScript.goingOnce(state.auction.amount), null, { style: "countdown", priority: SPEECH_PRIORITY.countdown });
    resumeAuctionFlow();
  } else if (state.auction.phase === "twice") {
    speak(auctioneerScript.goingTwice(state.auction.amount), null, { style: "countdown", priority: SPEECH_PRIORITY.countdown });
    resumeAuctionFlow();
  }
  else if (state.auction.phase === "sold") {
    const player = currentPlayer(state);
    const team = state.teams.find((item) => item.id === state.auction.highBidderId);
    const sale = state.sales.at(-1);
    const context = saleRoastContext(player, team, state.auction.amount);
    speak(auctioneerScript.sold({ player, team, amount: state.auction.amount }), () => {
      void maybeSpeakSaleRoast(sale?.id, context);
    }, { style: "sold", priority: SPEECH_PRIORITY.sold });
    scheduleAutoNomination();
  } else if (state.auction.phase === "passed" && before === "open") {
    speak(auctioneerScript.passed(currentPlayer(state)), null, { style: "passed", priority: SPEECH_PRIORITY.sold });
    scheduleAutoNomination();
  }
}

function scheduleCountdown() {
  clearTimer();
  if (!autoEnabled || pendingVisualTie || visualBidWindow || !["open", "once", "twice"].includes(state.auction.phase)) return;
  const delay = COUNTDOWN_DELAYS[state.auction.phase];
  countdownTimer = window.setTimeout(runCountdownStep, delay);
}

function resumeAuctionFlow() {
  scheduleCountdown();
  scheduleAutoDraftBid();
  void refillPatterQueue();
  schedulePatter();
}

function schedulePatter() {
  clearPatter();
  if (!voiceEnabled
    || !auctioneerProfile.playByPlayEnabled
    || !isLiveAuctionPhase(state.auction.phase)
    || pendingVisualTie
    || visualBidWindow
    || document.querySelector("#audio-dialog")?.open) return;
  const delay = patterDelayMs({ energy: auctioneerProfile.energy, sequence: patterSequence });
  patterSequence += 1;
  patterTimer = window.setTimeout(speakPatter, delay);
}

function speakPatter() {
  patterTimer = null;
  if (!voiceEnabled || !auctioneerProfile.playByPlayEnabled || !isLiveAuctionPhase(state.auction.phase) || pendingVisualTie || visualBidWindow) return;
  if (auctioneerVoice.isSpeaking) {
    patterTimer = window.setTimeout(speakPatter, 120);
    return;
  }
  const player = currentPlayer(state);
  if (!player) return;
  const highBidder = state.teams.find((team) => team.id === state.auction.highBidderId);
  const nextAmount = Math.max(1, state.auction.amount + state.config.increment);
  const key = currentPatterKey();
  if (patterQueueKey !== key) {
    patterQueue = [];
    patterQueueKey = key;
  }
  const localLine = () => auctioneerScript.patter({
    player,
    amount: state.auction.amount,
    manager: highBidder?.manager || null,
    nextAmount,
    phase: state.auction.phase,
    suggestedValue: Number(player.suggestedValue) || 0
  });
  const passageCandidates = patterQueue.length
    ? patterQueue.splice(0, patterQueue.length)
    : Array.from({ length: LOCAL_PATTER_PASSAGE_LINES }, localLine);
  const passage = buildPatterPassage(passageCandidates);
  if (!passage.text) return schedulePatter();
  recentPatterLines = [...recentPatterLines, ...passage.lines].slice(-8);
  if (patterQueue.length <= 1) void refillPatterQueue();
  speak(passage.text, schedulePatter, { style: "patter", priority: SPEECH_PRIORITY.patter });
}

async function refillPatterQueue() {
  if (!voiceEnabled || !auctioneerProfile.playByPlayEnabled || !isLiveAuctionPhase(state.auction.phase)) return;
  if (auctioneerService.patter?.available === false) return;
  const key = currentPatterKey();
  if (!key) return;
  if (patterQueueKey !== key) {
    patterQueue = [];
    patterQueueKey = key;
  }
  if (patterRequest?.key === key || patterQueue.length > 1) return;
  const requestId = ++patterRequestSequence;
  patterRequest = { key, requestId };
  try {
    const response = await fetch("/api/auctioneer/patter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: livePatterContext(),
        recentLines: recentPatterLines,
        personality: auctioneerProfile.personality,
        energy: auctioneerProfile.energy
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || currentPatterKey() !== key || !Array.isArray(payload.lines) || payload.lines.length !== 3) return;
    const recent = new Set(recentPatterLines.map((line) => line.toLowerCase()));
    const freshLines = payload.lines
      .map((line) => String(line || "").trim())
      .filter((line) => line && !recent.has(line.toLowerCase()));
    patterQueue = [...patterQueue, ...freshLines].slice(0, 5);
  } catch {
    // The local rotating script keeps the room moving without waiting for the model.
  } finally {
    if (patterRequest?.requestId === requestId) patterRequest = null;
  }
}

function currentPatterKey() {
  if (!isLiveAuctionPhase(state.auction.phase)) return "";
  return [state.auction.playerId, state.auction.phase, state.auction.amount, state.auction.highBidderId, state.auction.bidCount].join(":");
}

function livePatterContext() {
  const player = currentPlayer(state);
  const highBidder = state.teams.find((team) => team.id === state.auction.highBidderId);
  const roster = (highBidder?.roster || []).map((spot) => {
    const rosterPlayer = state.players.find((item) => item.id === spot.playerId);
    return { name: rosterPlayer?.name, position: rosterPlayer?.position, price: spot.price };
  });
  const recentSales = state.sales.slice(-5).map((sale) => ({
    playerName: state.players.find((item) => item.id === sale.playerId)?.name,
    managerName: state.teams.find((team) => team.id === sale.teamId)?.manager,
    amount: sale.amount
  }));
  return {
    phase: state.auction.phase,
    playerName: player?.name,
    position: player?.position,
    nflTeam: player?.nflTeam,
    amount: state.auction.amount,
    nextAmount: Math.max(1, state.auction.amount + state.config.increment),
    suggestedValue: player?.suggestedValue,
    highBidderManager: highBidder?.manager,
    highBidderTeam: highBidder?.name,
    highBidderBudgetRemaining: highBidder?.budget,
    bidCount: state.auction.bidCount,
    roster,
    recentSales
  };
}

function clearTimer() {
  if (countdownTimer) window.clearTimeout(countdownTimer);
  countdownTimer = null;
}

function clearPatter() {
  if (patterTimer) window.clearTimeout(patterTimer);
  patterTimer = null;
}

function speak(text, onDone, { style = "neutral", priority = 0, interrupt = true, queueKey = null } = {}) {
  if (!voiceEnabled) { onDone?.(); return; }
  auctioneerVoice.speak(text, {
    style,
    priority,
    interrupt,
    queueKey,
    personality: auctioneerProfile.personality,
    energy: auctioneerProfile.energy,
    onDone
  });
}

function saleRoastContext(player, team, amount) {
  const roster = (team?.roster || []).map((spot) => {
    const rosterPlayer = state.players.find((item) => item.id === spot.playerId);
    return {
      name: rosterPlayer?.name,
      position: rosterPlayer?.position,
      nflTeam: rosterPlayer?.nflTeam,
      price: spot.price
    };
  });
  return {
    managerName: team?.manager,
    fantasyTeamName: team?.name,
    playerName: player?.name,
    position: player?.position,
    nflTeam: player?.nflTeam,
    amount,
    suggestedValue: player?.suggestedValue,
    budgetRemaining: team?.budget,
    rosterCount: roster.length,
    rosterSize: state.config.rosterSize,
    roster
  };
}

async function maybeSpeakSaleRoast(saleId, context) {
  if (
    !saleId
    || !voiceEnabled
    || !auctioneerProfile.roastingEnabled
    || !shouldRoastSale(context)
  ) return;
  try {
    const response = await fetch("/api/auctioneer/roast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context,
        recentRoasts,
        personality: auctioneerProfile.personality
      })
    });
    const payload = await response.json().catch(() => ({}));
    const saleStillCurrent = state.auction.phase === "sold" && state.sales.at(-1)?.id === saleId;
    if (!response.ok || !saleStillCurrent || !voiceEnabled || !auctioneerProfile.roastingEnabled || !payload.text) return;
    recentRoasts = [...recentRoasts, String(payload.text)].slice(-20);
    speak(payload.text, null, { style: "roast", priority: SPEECH_PRIORITY.roast });
  } catch {}
}

async function runAudioPreflight(button) {
  const form = document.querySelector("#audio-form");
  if (!form) return;
  const data = new FormData(form);
  const personality = AUCTIONEER_PERSONALITIES[data.get("personality")] ? data.get("personality") : "classic";
  const energy = Math.min(3, Math.max(1, Number(data.get("energy")) || 2));
  const provider = ["auto", "elevenlabs", "cartesia"].includes(data.get("provider")) ? data.get("provider") : "auto";
  const check = form.querySelector("[data-audio-check]");
  clearPatter();
  button.disabled = true;
  if (check) check.textContent = "Lucy is speaking now…";
  await auctioneerVoice.unlock();
  await auctioneerVoice.setProvider(provider);
  const previewScript = createAuctioneerScript({ personality });
  auctioneerVoice.speak(previewScript.preflight(), {
    style: "preflight",
    priority: SPEECH_PRIORITY.preflight,
    personality,
    energy,
    onDone: () => {
      if (check?.isConnected) check.textContent = "Audio check complete. Ask the room for a thumbs-up.";
      if (button?.isConnected) button.disabled = false;
    }
  });
}

function updateAudioServiceStatus() {
  const dialog = document.querySelector("#audio-dialog");
  const card = dialog?.querySelector(".audio-provider-card");
  const label = dialog?.querySelector("[data-audio-provider-label]");
  const message = dialog?.querySelector("[data-audio-provider-message]");
  const roastMessage = dialog?.querySelector("[data-roast-provider-message]");
  const patterMessage = dialog?.querySelector("[data-patter-provider-message]");
  card?.classList.toggle("is-fallback", auctioneerService.provider === "browser");
  if (label) label.textContent = audioProviderLabel();
  if (message) message.textContent = auctioneerService.message;
  if (roastMessage) roastMessage.textContent = `${roastWriterLabel()} Dark, vulgar jokes target bids and draft decisions—not protected traits.`;
  if (patterMessage) patterMessage.textContent = `${patterDirectorLabel()} Bids wait for the current line; rulings interrupt.`;
}

function stopAuctioneer() {
  clearPatter();
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
  clearPatter();
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
    resumeAuctionFlow();
    return;
  }
  if (result.kind === "bid") {
    try { submitBid(result.teamId, result.amount, { source: batch.source }); }
    catch (error) { showNotice({ kind: "error", message: error.message }); resumeAuctionFlow(); }
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
  catch (error) { showNotice({ kind: "error", message: error.message }); resumeAuctionFlow(); }
}

function cancelVisualTie() {
  clearVisualBidWindow();
  pendingVisualTie = null;
  render();
  resumeAuctionFlow();
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
      teams: state.teams.map((team) => ({
        id: team.id,
        name: team.name,
        manager: team.manager,
        color: team.color,
        autoDraft: isAutoTeam(team)
      }))
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
    const parsed = parseCsv(text);
    pendingCsvImport = {
      fileName: file.name || "players.csv",
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: suggestCsvMapping(parsed.headers)
    };
    render();
    document.querySelector("#csv-mapping-dialog")?.showModal();
  } catch (error) { showNotice({ kind: "error", message: error.message }); }
}

async function openResultsPage() {
  const payload = buildResultsPayload(state);
  const encoded = await encodeResultsPayload(payload);
  window.location.assign(`./results.html#${encoded}`);
}

function loadFantasyProsPreset() {
  clearTimer();
  clearAutoDraftTimer();
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
  scheduleAutoNomination();
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
  const profileName = AUCTIONEER_PERSONALITIES[auctioneerProfile.personality]?.name || "Lucy";
  if (auctioneerService.status === "ready" && auctioneerService.available) return `${profileName} is on with ${providerName(auctioneerService.provider)} ${auctioneerService.model}`;
  return `${profileName} is on with browser voice fallback`;
}

function audioProviderLabel() {
  if (auctioneerService.provider === "browser" || auctioneerService.available === false) return "BROWSER VOICE FAILOVER ACTIVE";
  const cached = Number(auctioneerService.countdownCacheEntries) || 0;
  return `${providerName(auctioneerService.provider).toUpperCase()} REALTIME · ${cached} COUNTDOWN${cached === 1 ? "" : "S"} CACHED`;
}

function providerName(provider) {
  return provider === "elevenlabs" ? "ElevenLabs" : provider === "cartesia" ? "Cartesia" : "Browser voice";
}

function providerOptionCopy(provider) {
  const status = auctioneerService.providers?.[provider];
  if (!status) return "Checking availability";
  if (!status.available) return provider === "elevenlabs" ? "Needs API key + voice ID" : "Needs API key";
  return status.connected ? "Warm persistent stream" : `${status.model || "Realtime"} · ready on demand`;
}

function patterDirectorLabel() {
  return auctioneerService.patter?.provider === "openai"
    ? "The AI Patter Director writes three-line live arcs ahead of playback."
    : "Lucy's local rotation fills live gaps with rapid stadium-style patter.";
}

function roastWriterLabel() {
  return auctioneerService.roasting?.provider === "openai"
    ? "OpenAI riffs on the live bidding context."
    : "Lucy uses the built-in contextual roast rotation.";
}

function restoreDraft() {
  try {
    const restored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!restored) return null;
    restored.config = {
      ...restored.config,
      rosterRequirements: Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Number(restored.config?.rosterRequirements?.[position]) || 0]))
    };
    restored.teams = (restored.teams || []).map((team) => ({ ...team, controller: autoTeamController(team.controller) }));
    restored.nomination ||= { order: restored.teams.map((team) => team.id), currentIndex: 0 };
    restored.auction = { nominatorTeamId: null, autoIntents: {}, autoIntentStatus: "idle", ...restored.auction };
    return restored;
  } catch { return null; }
}

function restoreAuctioneerProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUCTIONEER_PROFILE_STORAGE_KEY));
    return {
      enabled: saved?.enabled !== false,
      playByPlayEnabled: saved?.playByPlayEnabled !== false,
      roastingEnabled: saved?.roastingEnabled !== false,
      provider: ["auto", "elevenlabs", "cartesia"].includes(saved?.provider) ? saved.provider : "auto",
      personality: AUCTIONEER_PERSONALITIES[saved?.personality] ? saved.personality : "classic",
      energy: Math.min(3, Math.max(1, Number(saved?.energy) || 2))
    };
  } catch { return { enabled: true, playByPlayEnabled: true, roastingEnabled: true, provider: "auto", personality: "classic", energy: 2 }; }
}

function normalizedRequirements() {
  return Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Number(state.config.rosterRequirements?.[position]) || 0]));
}

function orderedTeamsForSetup() {
  const byId = new Map(state.teams.map((team) => [team.id, team]));
  const ordered = (state.nomination?.order || []).map((id) => byId.get(id)).filter(Boolean);
  return [...ordered, ...state.teams.filter((team) => !ordered.includes(team))];
}

function syncAutodraftTeamSetup() {
  const form = document.querySelector("#setup-form");
  if (!form) return;
  const count = Math.min(12, Math.max(2, Number(form.elements.teamCount?.value) || state.teams.length));
  const teams = parseTeamSetupLines(form.elements.teamNames?.value);
  form.querySelectorAll("[data-auto-team-slot]").forEach((slot) => {
    const index = Number(slot.dataset.autoTeamSlot);
    slot.hidden = index >= count;
    const { name, manager } = teams[index] || {};
    const strong = slot.querySelector("strong");
    const small = slot.querySelector("small");
    if (strong) strong.textContent = manager || `Manager ${index + 1}`;
    if (small) small.textContent = name || `Team ${index + 1}`;
  });
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
    trophy: '<path d="M8 4h8v4a4 4 0 0 1-8 0V4Z"/><path d="M8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 12v5M8 21h8M9 17h6"/>',
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
