import { makeTeams, parseTeamSetupLines } from "./data.mjs";
import { fantasyProsPlayers } from "./fantasy-pros-data.mjs";
import { AuctioneerVoice } from "./auctioneer-voice.mjs";
import { RemoteSpeechRelay } from "./remote-speech-relay.mjs";
import {
  AUCTIONEER_SPEED_OPTIONS,
  auctioneerSpeedAt,
  auctioneerSpeedIndex,
  normalizeAuctioneerSpeed
} from "./auctioneer-speed.mjs";
import { createAuctioneerScript, AUCTIONEER_PERSONALITIES } from "./auctioneer-script.mjs";
import {
  buildPatterPassage,
  isLiveAuctionPhase,
  LOCAL_PATTER_PASSAGE_LINES,
  patterDelayMs
} from "./auctioneer-patter.mjs";
import { shouldRoastSale } from "./roast-engine.mjs";
import { buildPhoneAuctionHistory, classifyPhoneBidBatch } from "./phone-bidding.mjs";
import { LanRoomTransport, RelayRoomTransport } from "./room-transports.mjs";
import { validateDraftState } from "./draft-state-validation.mjs";
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
  correctSale,
  currentPlayer,
  maxBidForTeam,
  nextLegalBidAmount,
  currentNominator,
  canTeamRosterPlayer,
  ROSTER_POSITIONS,
  DEFAULT_COUNTDOWN_SECONDS,
  countdownDelayMs,
  normalizeCountdownSeconds
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
const PERSONAL_SETUP_STORAGE_KEY = "sun-god-personal-setup-v1";
const SPEECH_PRIORITY = { patter: 20, nomination: 30, countdown: 50, bid: 100, roast: 105, sold: 110, ruling: 120, preflight: 130 };
const STANDARD_ROSTER_REQUIREMENTS = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1 };
const app = document.querySelector("#app");
const hostToken = await loadHostSession();
const restoredRelaySession = await globalThis.sunGod?.relaySession?.get?.();
const durableDraft = await loadDurableDraft();
const legacyDraft = restoreDraft();
const restoredDraftState = withoutMarketValues(restoreDraft(durableDraft.state) || legacyDraft);
const replacedFictionalPlayers = hasFictionalPlayers(restoredDraftState);
let draftRevision = durableDraft.revision || 0;
let draftSavePromise = Promise.resolve();
let durableSaveFailed = false;
let emergencyLocked = false;
let state = restoredDraftState && !replacedFictionalPlayers
  ? restoredDraftState
  : createFantasyProsDraft(restoredDraftState);
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
let notice = replacedFictionalPlayers
  ? { kind: "success", message: `Replaced the fictional player pool with ${fantasyProsPlayers.length} FantasyPros CSV players and values.` }
  : null;
let pendingVisualTie = null;
let visualBidWindow = null;
let phoneRoomTransport = null;
let phoneRoomSyncTimer = null;
let phoneRoom = {
  mode: restoredRelaySession?.expiresAt > Date.now() ? "remote" : "local",
  roomId: restoredRelaySession?.roomId || localStorage.getItem(PHONE_ROOM_ID_STORAGE_KEY) || createRoomCode(),
  hostKey: localStorage.getItem(PHONE_ROOM_HOST_KEY_STORAGE_KEY) || createHostKey(),
  status: "starting",
  joinUrl: restoredRelaySession?.bidderUrl || "",
  relayUrl: restoredRelaySession?.relayUrl || "",
  relaySecret: restoredRelaySession?.hostSessionSecret || "",
  meetingLink: restoredRelaySession?.meetingLink || "",
  latencyMs: null,
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
const remoteSpeechRelay = new RemoteSpeechRelay({
  getTransport: () => phoneRoom.mode === "remote" && phoneRoom.status === "live" ? phoneRoomTransport : null
});
const auctioneerVoice = new AuctioneerVoice({
  provider: auctioneerProfile.provider,
  fetchImpl: hostFetch,
  onPlaybackEvent: (event) => remoteSpeechRelay.handle(event),
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
if (globalThis.sunGod?.isDesktop && localStorage.getItem(PERSONAL_SETUP_STORAGE_KEY) !== "complete") {
  window.setTimeout(() => document.querySelector("#onboarding-dialog")?.showModal(), 0);
}
if (!durableDraft.state || replacedFictionalPlayers) persistDraft();
void auctioneerVoice.initialize(auctioneerProfile.provider);
void initializeBiddingRoom();
if (state.auction.phase === "ready") void prepareAutoIntents();
else if (isLiveAuctionPhase(state.auction.phase)) { freezeLocalAutoIntents(); resumeAuctionFlow(); }
else scheduleAutoNomination();

function render() {
  const openDialogId = document.querySelector("dialog[open]")?.id;
  const player = currentPlayer(state);
  const highBidder = state.teams.find((team) => team.id === state.auction.highBidderId);
  const nextNominator = currentNominator(state);
  const lotNominator = state.teams.find((team) => team.id === state.auction.nominatorTeamId) || nextNominator;
  const participantNominator = ["ready", "open", "once", "twice"].includes(state.auction.phase) ? lotNominator : nextNominator;
  const available = state.players.filter((item) => item.status === "available");
  const humanTeamCount = state.teams.filter((team) => !isAutoTeam(team)).length;
  const nextPlayers = state.queue
    .map((id) => state.players.find((item) => item.id === id))
    .filter((item) => item?.status === "available" && item.id !== player?.id)
    .slice(0, 5);

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
          <button class="device-button ${emergencyLocked ? "is-on" : ""}" data-action="emergency-lock" title="Pause bidding and enable historical corrections">${emergencyLocked ? "UNLOCK" : "LOCK"}</button>
          <button class="device-button ${phoneRoom.status === "live" ? "is-on" : ""}" data-action="focus-phone-room" title="Show phone bidding room">${icon("phone")} <span>${phoneRoom.claimedTeamIds.length}/${humanTeamCount} phones</span></button>
          ${globalThis.sunGod?.diagnostics ? `<button class="icon-button" data-action="export-diagnostics" title="Export redacted diagnostics">${icon("database")}</button>` : ""}
          ${globalThis.sunGod?.isDesktop ? `<button class="icon-button" data-action="personal-settings" title="Personal relay and provider settings">${icon("key")}</button>` : ""}
          <button class="icon-button ${voiceEnabled ? "is-on" : ""}" data-action="audio-settings" title="${escapeHtml(auctioneerVoiceTitle())}">${icon("volume")}</button>
          <button class="icon-button" data-action="setup" title="League setup">${icon("settings")}</button>
        </div>
      </header>

      ${notice ? `<div class="notice ${notice.kind}"><span>${escapeHtml(notice.message)}</span><button data-action="dismiss-notice">×</button></div>` : ""}
      ${pendingVisualTie ? visualTieConfirmation() : ""}

      <main class="draft-grid">
        <div class="draft-column draft-column-left">
          <section id="phone-room-panel" class="phone-room-panel panel">
            <div class="panel-heading">
              <div><span class="eyebrow">${phoneRoom.mode === "remote" ? "REMOTE BIDDING" : "LOCAL PHONE BIDDING"}</span><h2>Draft room</h2></div>
              <span class="phone-room-status ${phoneRoom.status === "live" ? "is-live" : ""}"><i></i>${phoneRoomStatusLabel()}</span>
            </div>
            <div class="phone-join-card">
              <div class="phone-qr">${phoneRoom.joinUrl ? qrCodeSvg(phoneRoom.joinUrl) : `<span>${icon("phone")}</span>`}</div>
              <div class="phone-join-copy">
                <small>ROOM CODE</small>
                <strong>${escapeHtml(phoneRoom.roomId)}</strong>
                <p>${phoneRoom.joinUrl ? phoneRoom.mode === "remote" ? "Local and remote phones use this relay link." : "Scan to join on the same Wi-Fi." : "Preparing the phone room…"}</p>
                <span title="${escapeHtml(phoneRoom.joinUrl)}">${escapeHtml(phoneRoom.joinUrl || "Finding this Mac’s network address…")}</span>
              </div>
            </div>
            <div class="phone-room-actions">
              <button data-action="toggle-bidding-mode">${phoneRoom.mode === "remote" ? "Local only" : "Remote bidders"}</button>
              <button data-action="phone-preflight">Preflight</button>
              <button data-action="copy-phone-link" ${phoneRoom.joinUrl ? "" : "disabled"}>${icon("copy")} Copy link</button>
              <button data-action="reset-phone-claims" ${phoneRoom.mode === "remote" || !phoneRoom.claimedTeamIds.length ? "disabled" : ""}>Reset</button>
            </div>
            ${phoneRoom.error ? `<p class="phone-room-error" role="alert">${escapeHtml(phoneRoom.error)}</p>` : ""}
          </section>

          <aside class="queue-panel panel">
            <div class="panel-heading">
              <div><span class="eyebrow">PLAYER POOL</span><h2>Nominate next</h2><span class="nomination-chip">${escapeHtml(nextNominator?.manager || "Commissioner")} is up</span></div>
              <label class="search-box">${icon("search")}<input id="player-search" placeholder="Find player" autocomplete="off" /></label>
            </div>
            <div id="search-results" class="search-results"></div>
            <div class="queue-list">
              ${nextPlayers.length ? nextPlayers.map((item, index) => queueRow(item, index)).join("") : `<p class="empty-copy">No players left in the queue.</p>`}
            </div>
            <div class="queue-actions">
              <button class="fantasy-pros-button" data-action="load-fantasy-pros" title="Replace the current draft with the supplied FantasyPros CSV players and auction values">
                ${icon("database")}
                <span><strong>Reload player values</strong><small>${fantasyProsPlayers.length} players · resets draft</small></span>
                ${icon("arrow")}
              </button>
              <button class="text-button csv-import-button" data-action="import">${icon("upload")} Import CSV</button>
              <a class="text-button csv-import-button" href="/assets/player-template.csv" download>CSV template</a>
              <input id="csv-input" type="file" accept=".csv,text/csv" hidden />
            </div>
          </aside>
        </div>

        <section class="auction-stage">
          <div class="stage-glow"></div>
          ${player ? playerCard(player, highBidder, lotNominator) : emptyStage(nextNominator)}
        </section>

        <aside class="ledger-panel panel">
          <div class="panel-heading">
            <div><span class="eyebrow">DRAFT LEDGER</span><h2>Auction history</h2></div>
            <div class="ledger-tools"><button class="text-button" data-action="export-backup">Backup</button><button class="text-button" data-action="import-backup">Restore</button><button class="text-button" data-action="undo" ${state.sales.length ? "" : "disabled"}>Undo last</button><input id="backup-input" type="file" accept="application/json,.json" hidden /></div>
          </div>
          <div class="sales-list">
            ${state.sales.length ? [...state.sales].reverse().map(saleRow).join("") : `<p class="empty-copy">Every completed sale will appear here.</p>`}
          </div>
          <button class="draft-results-button" data-action="results">${icon("trophy")}<span><strong>View & export results</strong><small>Summary · CSV · ESPN · Yahoo · Sleeper</small></span>${icon("arrow")}</button>
        </aside>

        <section class="participants-panel panel">
          <div class="participants-heading">
            <div><span class="eyebrow">PARTICIPANTS</span><h2>Managers</h2></div>
            <strong class="participants-count">${phoneRoom.claimedTeamIds.length}/${humanTeamCount}</strong>
          </div>
          <div class="phone-claim-grid">
            ${state.teams.map((team) => {
              const joined = phoneRoom.claimedTeamIds.includes(team.id);
              const automatic = isAutoTeam(team);
              const nominating = team.id === participantNominator?.id;
              const status = nominating ? "NOMINATING" : automatic ? "AUTO" : joined ? "READY" : "WAIT";
              return `<div class="phone-claim ${joined || automatic ? "is-joined" : ""} ${automatic ? "is-auto" : ""} ${nominating ? "is-nominator" : ""}" title="${escapeHtml(team.name)} · ${nominating ? "Currently nominating" : automatic ? "Auto draft" : joined ? "Phone ready" : "Waiting for phone"}"><i style="background:${team.color}"></i><span><strong>${escapeHtml(team.manager)}</strong><small>${status}</small></span>${icon(automatic ? "settings" : joined ? "check" : "phone")}</div>`;
            }).join("")}
          </div>
        </section>
      </main>
    </div>
    <dialog id="setup-dialog">${setupDialog()}</dialog>
    <dialog id="csv-mapping-dialog">${pendingCsvImport ? csvMappingDialog() : ""}</dialog>
    <dialog id="audio-dialog">${audioDialog()}</dialog>
    ${globalThis.sunGod?.isDesktop ? `<dialog id="onboarding-dialog">${onboardingDialog()}</dialog>` : ""}
  `;
  if (openDialogId) window.setTimeout(() => document.querySelector(`#${openDialogId}`)?.showModal(), 0);
}

function onboardingDialog() {
  return `<form id="onboarding-form" method="dialog">
    <div class="dialog-head"><div><span class="eyebrow">PERSONAL LEAGUE</span><h2>Commissioner setup</h2></div></div>
    <p>Sun God is local-first. Add your private relay settings for remote league members; Lucy’s live voice can also play on each bidder phone.</p>
    <div class="form-grid">
      <label>Personal relay URL (optional)<input name="SUN_GOD_RELAY_URL" type="url" placeholder="https://your-relay.workers.dev" autocomplete="off" /></label>
      <label>Personal relay admin secret<input name="SUN_GOD_RELAY_ADMIN_SECRET" type="password" autocomplete="off" /></label>
      <label>OpenAI key (optional)<input name="OPENAI_API_KEY" type="password" autocomplete="off" /></label>
      <label>ElevenLabs key (optional)<input name="ELEVENLABS_API_KEY" type="password" autocomplete="off" /></label>
      <label>ElevenLabs voice ID<input name="ELEVENLABS_VOICE_ID" autocomplete="off" /></label>
      <label>Cartesia key (optional)<input name="CARTESIA_API_KEY" type="password" autocomplete="off" /></label>
    </div>
    <label class="audio-enabled-row"><span><strong>Trusted network understood</strong><small>Local mode exposes the bidder page to devices on this Mac’s Wi-Fi.</small></span><input name="trusted" type="checkbox" required /><b></b></label>
    <label class="audio-enabled-row"><span><strong>Backup test complete</strong><small>Use Backup in the ledger and keep the JSON somewhere safe.</small></span><input name="backup" type="checkbox" required /><b></b></label>
    <label class="audio-enabled-row"><span><strong>Phone and speaker test complete</strong><small>Claim a sample team, bid on demo data, and background/foreground the phone.</small></span><input name="preflight" type="checkbox" required /><b></b></label>
    <div class="dialog-actions"><button type="button" class="secondary-action" data-action="export-backup">Export backup test</button><button type="button" class="secondary-action" data-action="test-audio">Test speaker</button><button type="submit" class="primary-action">Finish setup</button></div>
  </form>`;
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
    <div class="bid-display ${highBidder ? "has-bid" : ""}">
      <span class="bid-label">${highBidder ? "CURRENT BID" : "OPENING BID"}</span>
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

function saleRow(sale) {
  const player = state.players.find((item) => item.id === sale.playerId);
  const team = state.teams.find((item) => item.id === sale.teamId);
  return `<button class="sale-row" data-action="correct-sale" data-sale-id="${escapeHtml(sale.id)}" ${emergencyLocked ? "" : "disabled"}><span class="mini-position ${escapeHtml(player.position.toLowerCase())}">${escapeHtml(player.position)}</span><span><strong>${escapeHtml(player.name)}</strong><small>${escapeHtml(team.name)}</small></span><b>$${sale.amount}</b></button>`;
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
      <p>Set the salary-cap basics and automatic count windows. The next two steps define legal rosters and who nominates.</p>
      <div class="form-grid">
        <label>Teams<input name="teamCount" type="number" min="2" max="12" value="${state.teams.length}" required /></label>
        <label>Budget per team<input name="budget" type="number" min="20" max="1000" value="${state.config.budget}" required /></label>
        <label>Bid increment<input name="increment" type="number" min="1" max="20" value="${state.config.increment}" required /></label>
      </div>
      <fieldset class="countdown-settings">
        <legend>AUTOMATIC COUNT WINDOWS</legend>
        <p>Choose how long bidding stays open after each audible count.</p>
        <div class="countdown-slider-grid">
          ${countdownSlider({
            name: "countdownOnceSeconds",
            title: "Going once",
            description: "Before going twice",
            value: state.config.countdownOnceSeconds
          })}
          ${countdownSlider({
            name: "countdownTwiceSeconds",
            title: "Going twice",
            description: "Before sold",
            value: state.config.countdownTwiceSeconds
          })}
        </div>
      </fieldset>
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
      <fieldset class="autodraft-team-fieldset"><legend>AUTO DRAFT CONTROL</legend><p>Marked teams cannot be claimed by a phone. AI chooses pass, discount, value, or target once per nomination; local rules place every bid.</p>
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
  const selectedSpeedIndex = auctioneerSpeedIndex(auctioneerProfile.speed);
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
    <label class="audio-enabled-row roast-enabled-row"><span><strong>Dark fantasy roasts</strong><small data-roast-provider-message>${escapeHtml(roastWriterLabel())} A joke follows every completed sale and targets draft decisions—not protected traits.</small></span><input name="roastingEnabled" type="checkbox" ${auctioneerProfile.roastingEnabled ? "checked" : ""} /><b></b></label>
    <fieldset class="audio-fieldset"><legend>PERSONALITY</legend><div class="personality-grid">
      ${Object.entries(AUCTIONEER_PERSONALITIES).map(([id, profile]) => `<label class="personality-option"><input type="radio" name="personality" value="${id}" ${auctioneerProfile.personality === id ? "checked" : ""} /><span><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.description)}</small></span><i>✓</i></label>`).join("")}
    </div></fieldset>
    <fieldset class="audio-fieldset"><legend>ENERGY LEVEL</legend><div class="energy-grid">
      ${[[1, "Measured", "Calm pacing"], [2, "Draft night", "Balanced"], [3, "Full send", "Maximum lift"]].map(([value, name, copy]) => `<label><input type="radio" name="energy" value="${value}" ${auctioneerProfile.energy === value ? "checked" : ""} /><span><strong>${name}</strong><small>${copy}</small></span></label>`).join("")}
    </div></fieldset>
    <fieldset class="audio-fieldset"><legend>TALKING SPEED</legend>
      <label class="speed-slider">
        <span><strong>Auctioneer pace</strong><output data-auctioneer-speed-output>${AUCTIONEER_SPEED_OPTIONS[selectedSpeedIndex].label}</output></span>
        <input name="speedIndex" type="range" min="0" max="${AUCTIONEER_SPEED_OPTIONS.length - 1}" step="1" value="${selectedSpeedIndex}" data-auctioneer-speed-slider />
        <i>${AUCTIONEER_SPEED_OPTIONS.map((option) => `<small>${option.label}</small>`).join("")}</i>
      </label>
    </fieldset>
    <div class="audio-preflight"><span><small>ROOM CHECK</small><strong data-audio-check>Make sure every manager can hear the auctioneer.</strong></span><button type="button" data-action="test-audio">${icon("volume")} Can you hear Lucy?</button></div>
    <div class="audio-cache-note">${icon("database")} Common countdown calls are cached after first playback. If realtime audio stalls, Sun God automatically finishes with a browser voice.</div>
    <div class="dialog-actions"><button type="button" data-action="close-audio" class="secondary-action">Cancel</button><button type="submit" class="primary-action">Save audio settings</button></div>
  </form>`;
}

function countdownSlider({ name, title, description, value }) {
  const fallback = name === "countdownTwiceSeconds" ? DEFAULT_COUNTDOWN_SECONDS.twice : DEFAULT_COUNTDOWN_SECONDS.once;
  const seconds = normalizeCountdownSeconds(value, fallback);
  return `<label class="countdown-slider">
    <span><strong>${title}</strong><small>${description}</small><output data-countdown-output>${seconds.toFixed(1)} sec</output></span>
    <input name="${name}" type="range" min="2" max="20" step="0.1" value="${seconds}" data-countdown-slider />
  </label>`;
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
      if (action === "personal-settings") return document.querySelector("#onboarding-dialog")?.showModal();
      if (action === "export-diagnostics") { await globalThis.sunGod.diagnostics.export(); return; }
      if (action === "toggle-bidding-mode") return await toggleBiddingMode();
      if (action === "phone-preflight") return await runPhonePreflight();
      if (action === "emergency-lock") return toggleEmergencyLock();
      if (action === "correct-sale") return correctHistoricalSale(button.dataset.saleId);
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
      if (action === "copy-phone-link") return await copyPhoneJoinLink();
      if (action === "reset-phone-claims") return await resetPhoneClaims();
      if (action === "nominate") return await selectNomination(button.dataset.playerId);
      if (action === "open") return beginAuction();
      if (action === "pause") { clearTimer(); clearAutoDraftTimer(); stopAuctioneer(); return update(pauseAuction(state)); }
      if (action === "advance") return runCountdownStep(true);
      if (action === "next") return await selectNextQueuedPlayer();
      if (action === "undo") {
        clearTimer();
        clearAutoDraftTimer();
        update(undoLastSale(state), "Last sale reversed.");
        return await prepareAutoIntents();
      }
      if (action === "results") return await openResultsPage();
      if (action === "export-backup") return exportDraftBackup();
      if (action === "import-backup") return document.querySelector("#backup-input")?.click();
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
    if (event.target.id === "backup-input") {
      void importDraftBackup(event.target.files?.[0]);
      event.target.value = "";
    }
  });

  app.addEventListener("input", (event) => {
    if (event.target.id === "player-search") renderSearchResults(event.target.value);
    if (event.target.name === "teamCount" || event.target.name === "teamNames") syncAutodraftTeamSetup();
    if (event.target.matches("[data-countdown-slider]")) {
      const output = event.target.closest(".countdown-slider")?.querySelector("[data-countdown-output]");
      if (output) output.textContent = `${Number(event.target.value).toFixed(1)} sec`;
    }
    if (event.target.matches("[data-auctioneer-speed-slider]")) {
      const output = event.target.closest(".speed-slider")?.querySelector("[data-auctioneer-speed-output]");
      if (output) output.textContent = auctioneerSpeedAt(event.target.value).label;
    }
  });

  app.addEventListener("submit", (event) => {
    if (event.target.id === "onboarding-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const credentials = Object.fromEntries(["SUN_GOD_RELAY_URL", "SUN_GOD_RELAY_ADMIN_SECRET", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "CARTESIA_API_KEY"].map((key) => [key, String(data.get(key) || "").trim()]).filter(([, value]) => value));
      void globalThis.sunGod.credentials.set(credentials).then(() => {
        localStorage.setItem(PERSONAL_SETUP_STORAGE_KEY, "complete");
        document.querySelector("#onboarding-dialog")?.close();
        showNotice({ kind: "success", message: "Personal setup saved. Restart once if you added relay or provider settings." });
      }).catch((error) => showNotice({ kind: "error", message: error.message }));
      return;
    }
    if (event.target.id === "audio-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      auctioneerProfile = {
        enabled: data.get("enabled") === "on",
        playByPlayEnabled: data.get("playByPlayEnabled") === "on",
        roastingEnabled: data.get("roastingEnabled") === "on",
        provider: ["auto", "elevenlabs", "cartesia"].includes(data.get("provider")) ? data.get("provider") : "auto",
        personality: AUCTIONEER_PERSONALITIES[data.get("personality")] ? data.get("personality") : "classic",
        energy: Math.min(3, Math.max(1, Number(data.get("energy")) || 2)),
        speed: auctioneerSpeedAt(data.get("speedIndex")).id
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
      showNotice({ kind: "success", message: `${AUCTIONEER_PERSONALITIES[auctioneerProfile.personality].name} is set to ${auctioneerSpeedAt(data.get("speedIndex")).label.toLowerCase()} speed at energy ${auctioneerProfile.energy}; play-by-play ${auctioneerProfile.playByPlayEnabled ? "on" : "off"}, roasts ${auctioneerProfile.roastingEnabled ? "on" : "off"}.` });
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
          countdownOnceSeconds: state.config.countdownOnceSeconds,
          countdownTwiceSeconds: state.config.countdownTwiceSeconds,
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
    const countdownOnceSeconds = normalizeCountdownSeconds(data.get("countdownOnceSeconds"), DEFAULT_COUNTDOWN_SECONDS.once);
    const countdownTwiceSeconds = normalizeCountdownSeconds(data.get("countdownTwiceSeconds"), DEFAULT_COUNTDOWN_SECONDS.twice);
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
      countdownOnceSeconds,
      countdownTwiceSeconds,
      nominationOrder: teams.map((team) => team.id)
    });
    clearVisualBidWindow();
    pendingVisualTie = null;
    persistDraft();
    document.querySelector("#setup-dialog")?.close();
    render();
    void initializeBiddingRoom();
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
    const response = await hostFetch("/api/autodraft/intent", {
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
  const next = nextLegalBidAmount(state);
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
    const roastPromise = prepareSaleRoast(sale?.id, context);
    let saleAnnouncementFinished = false;
    const finishSaleAnnouncement = () => {
      if (saleAnnouncementFinished) return;
      saleAnnouncementFinished = true;
      void finishSaleAnnouncementWithRoast(sale?.id, roastPromise);
    };
    speak(auctioneerScript.sold({ player, team, amount: state.auction.amount }), finishSaleAnnouncement, {
      style: "sold",
      priority: SPEECH_PRIORITY.sold,
      onCancel: finishSaleAnnouncement
    });
  } else if (state.auction.phase === "passed" && before === "open") {
    speak(auctioneerScript.passed(currentPlayer(state)), null, { style: "passed", priority: SPEECH_PRIORITY.sold });
    scheduleAutoNomination();
  }
}

function scheduleCountdown() {
  clearTimer();
  if (!autoEnabled || pendingVisualTie || visualBidWindow || !["open", "once", "twice"].includes(state.auction.phase)) return;
  const delay = countdownDelayMs(state.config, state.auction.phase);
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
  const nextAmount = nextLegalBidAmount(state);
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
    const response = await hostFetch("/api/auctioneer/patter", {
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
    nextAmount: nextLegalBidAmount(state),
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

function speak(text, onDone, { style = "neutral", priority = 0, interrupt = true, queueKey = null, onCancel } = {}) {
  if (!voiceEnabled) { onDone?.(); return; }
  auctioneerVoice.speak(text, {
    style,
    priority,
    interrupt,
    queueKey,
    personality: auctioneerProfile.personality,
    energy: auctioneerProfile.energy,
    speed: auctioneerProfile.speed,
    onCancel,
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
    budgetBeforePurchase: Number(team?.budget || 0) + Number(amount || 0),
    rosterCount: roster.length,
    rosterSize: state.config.rosterSize,
    bidCount: state.auction.bidCount,
    saleNumber: state.sales.length,
    roster
  };
}

async function prepareSaleRoast(saleId, context) {
  if (
    !saleId
    || !voiceEnabled
    || !auctioneerProfile.roastingEnabled
    || !shouldRoastSale(context)
  ) return null;
  try {
    const response = await hostFetch("/api/auctioneer/roast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context,
        recentRoasts,
        personality: auctioneerProfile.personality
      })
    });
    const payload = await response.json().catch(() => ({}));
    const saleStillExists = state.sales.some((sale) => sale.id === saleId);
    if (!response.ok || !saleStillExists || !voiceEnabled || !auctioneerProfile.roastingEnabled || !payload.text) return null;
    recentRoasts = [...recentRoasts, String(payload.text)].slice(-20);
    return String(payload.text);
  } catch {
    return null;
  }
}

async function finishSaleAnnouncementWithRoast(saleId, roastPromise) {
  const roast = await roastPromise;
  if (emergencyLocked) return;
  const saleStillExists = state.sales.some((sale) => sale.id === saleId);
  if (roast && saleStillExists && voiceEnabled && auctioneerProfile.roastingEnabled) {
    speak(roast, null, { style: "roast", priority: SPEECH_PRIORITY.roast });
  }
  scheduleAutoNomination();
}

async function runAudioPreflight(button) {
  const form = document.querySelector("#audio-form");
  if (!form) return;
  const data = new FormData(form);
  const personality = AUCTIONEER_PERSONALITIES[data.get("personality")] ? data.get("personality") : "classic";
  const energy = Math.min(3, Math.max(1, Number(data.get("energy")) || 2));
  const speed = auctioneerSpeedAt(data.get("speedIndex")).id;
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
    speed,
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
  if (roastMessage) roastMessage.textContent = `${roastWriterLabel()} A joke follows every completed sale and targets draft decisions—not protected traits.`;
  if (patterMessage) patterMessage.textContent = `${patterDirectorLabel()} Bids wait for the current line; rulings interrupt.`;
}

function stopAuctioneer() {
  clearPatter();
  auctioneerVoice.cancel();
}

function handlePhoneBid(bid) {
  if (!bid?.teamId) return;
  if (!["open", "once", "twice"].includes(state.auction.phase)) {
    if (phoneRoom.mode === "remote") phoneRoomTransport?.notify?.("bid.result", { teamId: bid.teamId, participantMessageId: bid.participantMessageId, amount: Number(bid.amount), status: "rejected" });
    return;
  }
  if (!canPlaceVisualBid(bid.teamId, Number(bid.amount))) {
    if (phoneRoom.mode === "remote") phoneRoomTransport?.notify?.("bid.result", { teamId: bid.teamId, participantMessageId: bid.participantMessageId, amount: Number(bid.amount), status: "rejected" });
    return;
  }
  if (visualBidWindow && !bidsShareWindow(visualBidWindow.openedAt, bid.receivedAt)) resolveVisualBidWindow();
  collectExternalBids([{ teamId: bid.teamId, amount: bid.amount, messageId: bid.participantMessageId || bid.id }], "phone", bid.receivedAt);
}

function collectExternalBids(bids, source, receivedAt = Date.now()) {
  const allowedTeamIds = pendingVisualTie ? new Set(pendingVisualTie.teamIds) : null;
  const eligibleBids = bids
    .map((bid) => ({ teamId: bid?.teamId, amount: Number(bid?.amount), messageId: bid?.messageId }))
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
    publishRelayBidResults(batch, result);
    pendingVisualTie = null;
    render();
    resumeAuctionFlow();
    return;
  }
  if (result.kind === "bid") {
    try {
      submitBid(result.teamId, result.amount, { source: batch.source });
      publishRelayBidResults(batch, result);
    } catch (error) {
      publishRelayBidResults(batch, { kind: "none" });
      showNotice({ kind: "error", message: error.message });
      resumeAuctionFlow();
    }
    return;
  }

  pendingVisualTie = {
    teamIds: result.teamIds,
    amount: result.amount,
    source: batch.source,
    round: batch.runoffRound + 1
  };
  publishRelayBidResults(batch, result);
  render();
  schedulePhoneRoomSync();
  const managers = result.teamIds
    .map((teamId) => state.teams.find((team) => team.id === teamId)?.manager)
    .filter(Boolean)
    .join(" and ");
  speak(auctioneerScript.simultaneous({ amount: result.amount, managers }), null, { style: "ruling", priority: SPEECH_PRIORITY.ruling });
}

function publishRelayBidResults(batch, result) {
  if (phoneRoom.mode !== "remote" || !phoneRoomTransport?.notify) return;
  for (const bid of batch?.bids?.values?.() || []) {
    const tied = result.kind === "tie" && result.teamIds.includes(bid.teamId) && bid.amount === result.amount;
    const accepted = result.kind === "bid" && result.teamId === bid.teamId && bid.amount === result.amount;
    phoneRoomTransport.notify("bid.result", {
      teamId: bid.teamId,
      participantMessageId: bid.messageId,
      amount: bid.amount,
      status: tied ? "tie pending" : accepted ? "accepted" : "outbid"
    });
  }
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

async function initializeBiddingRoom() {
  if (phoneRoom.mode === "remote") return initializeRelayRoom();
  return initializePhoneRoom();
}

async function initializePhoneRoom() {
  phoneRoom.status = "starting";
  phoneRoom.error = null;
  localStorage.setItem(PHONE_ROOM_ID_STORAGE_KEY, phoneRoom.roomId);
  localStorage.setItem(PHONE_ROOM_HOST_KEY_STORAGE_KEY, phoneRoom.hostKey);
  render();
  try {
    phoneRoomTransport?.close();
    phoneRoomTransport = new LanRoomTransport({ roomId: phoneRoom.roomId, hostFetchImpl: hostFetch });
    const snapshot = await phoneRoomTransport.createRoom({
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

async function initializeRelayRoom() {
  phoneRoom.status = "starting";
  phoneRoom.error = null;
  render();
  phoneRoomTransport?.close();
  phoneRoomTransport = new RelayRoomTransport({
    baseUrl: phoneRoom.relayUrl,
    roomId: phoneRoom.roomId,
    role: "host",
    credential: phoneRoom.relaySecret
  });
  phoneRoomTransport.connect((message) => {
    if (message.type === "room.snapshot") {
      const claimed = new Set(message.claims || []);
      applyPhoneRoomSnapshot({ ...message.room, teams: (message.room?.teams || []).map((team) => ({ ...team, claimed: claimed.has(team.id) })) }, { renderIfChanged: true });
    } else if (message.type === "bid.proposed") handlePhoneBid(message);
    else if (message.type === "heartbeat.ack" && message.sentAt) {
      phoneRoom.latencyMs = Date.now() - Number(message.sentAt);
      render();
    }
  }, ({ state: connectionState, error }) => {
    if (connectionState === "connected") {
      phoneRoom.status = "live";
      phoneRoom.error = null;
      render();
      void syncPhoneRoomState();
      measureRelayLatency();
    } else if (connectionState === "error") {
      phoneRoom.status = "error";
      phoneRoom.error = error || "The remote bidding relay could not authenticate this room.";
      showNotice({ kind: "error", message: phoneRoom.error });
    } else {
      remoteSpeechRelay.reset();
      phoneRoom.status = connectionState === "connecting" ? "starting" : "reconnecting";
      clearTimer();
      clearAutoDraftTimer();
      if (connectionState !== "connecting" && isLiveAuctionPhase(state.auction.phase)) {
        state = pauseAuction(state);
        persistDraft();
      }
      render();
    }
  });
}

async function toggleBiddingMode() {
  if (!["idle", "sold", "passed", "paused"].includes(state.auction.phase)) throw new Error("Pause the auction before changing phone transport modes.");
  clearTimer();
  clearAutoDraftTimer();
  if (phoneRoom.mode === "remote") {
    remoteSpeechRelay.reset();
    try { await phoneRoomTransport?.closeRoom?.(); } catch {}
    phoneRoomTransport?.close();
    phoneRoom.mode = "local";
    phoneRoom.roomId = createRoomCode();
    phoneRoom.joinUrl = "";
    phoneRoom.claimedTeamIds = [];
    await globalThis.sunGod?.relaySession?.set?.(null);
    return initializePhoneRoom();
  }
  const meetingLink = window.prompt("Optional HTTPS link for your Zoom, Meet, Discord, or FaceTime call:", phoneRoom.meetingLink || "")?.trim() || "";
  if (meetingLink && !/^https:\/\//i.test(meetingLink)) throw new Error("The league call link must start with https://.");
  const previousStatus = phoneRoom.status;
  phoneRoom.status = "starting";
  phoneRoom.error = null;
  render();
  let relay;
  try {
    const response = await hostFetch("/api/relay-room", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    relay = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(relay.error || "The personal relay could not create a room.");
    await globalThis.sunGod?.relaySession?.set?.({ ...relay, meetingLink });
  } catch (error) {
    phoneRoom.status = previousStatus;
    phoneRoom.error = error.message;
    render();
    throw error;
  }
  phoneRoomTransport?.close();
  phoneRoom = {
    ...phoneRoom, mode: "remote", roomId: relay.roomId, relayUrl: relay.relayUrl,
    relaySecret: relay.hostSessionSecret, joinUrl: relay.bidderUrl, meetingLink,
    claimedTeamIds: [], latencyMs: null, status: "starting", error: null
  };
  return initializeRelayRoom();
}

async function measureRelayLatency() {
  if (phoneRoom.mode !== "remote" || phoneRoom.status !== "live") return;
  const sentAt = Date.now();
  try {
    await phoneRoomTransport.request("heartbeat", { sentAt });
    phoneRoom.latencyMs = Date.now() - sentAt;
    render();
  } catch {}
}

async function runPhonePreflight() {
  const checks = [
    ["Durable draft save", !durableSaveFailed],
    ["Phone transport connected", phoneRoom.status === "live"],
    ["At least one human phone claimed", phoneRoom.claimedTeamIds.length > 0]
  ];
  if (phoneRoom.mode === "remote") {
    await measureRelayLatency();
    checks.push(["Relay round trip below 500 ms", Number(phoneRoom.latencyMs) > 0 && Number(phoneRoom.latencyMs) < 500]);
    checks.push(["League call link configured", /^https:\/\//i.test(phoneRoom.meetingLink)]);
  }
  const failures = checks.filter(([, passed]) => !passed).map(([label]) => label);
  if (failures.length) throw new Error(`Preflight needs attention: ${failures.join("; ")}. Claim a phone, submit a sample bid with a demo player, background/foreground it, and retry.`);
  showNotice({ kind: "success", message: `${phoneRoom.mode === "remote" ? "Remote" : "Local"} preflight passed. Complete one sample bid and phone background/foreground check before the real auction.` });
}

function connectPhoneRoomEvents() {
  phoneRoomTransport.connect((payload) => {
    if (["snapshot", "room", "state"].includes(payload.type)) {
      applyPhoneRoomSnapshot(payload.room, { renderIfChanged: true });
    } else if (payload.type === "bid") handlePhoneBid(payload);
  }, ({ state: connectionState }) => {
    if (connectionState === "connected") {
      if (phoneRoom.status !== "live") { phoneRoom.status = "live"; phoneRoom.error = null; render(); }
    } else if (phoneRoom.status !== "reconnecting") { phoneRoom.status = "reconnecting"; render(); }
  });
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
    const publicRoom = {
      roomId: phoneRoom.roomId,
      meetingLink: phoneRoom.mode === "remote" ? phoneRoom.meetingLink : "",
      history: buildPhoneAuctionHistory(state),
      auction: {
        phase: state.auction.phase,
        amount: state.auction.amount,
        nextBid: nextVisualBidAmount(state),
        highBidderId: state.auction.highBidderId,
        acceptingBids: ["open", "once", "twice"].includes(state.auction.phase) && !pendingVisualTie,
        player: player ? { id: player.id, name: player.name, position: player.position, nflTeam: player.nflTeam, suggestedValue: player.suggestedValue } : null
      },
      teams: state.teams.map((team) => ({
        id: team.id, name: team.name, manager: team.manager, color: team.color, autoDraft: isAutoTeam(team),
        budget: team.budget, rosterCount: team.roster.length, rosterSize: state.config.rosterSize,
        eligibleForPlayer: !player || canTeamRosterPlayer(state, team.id, player.id), maxBid: maxBidForTeam(state, team.id),
        roster: team.roster.map((spot) => {
          const rosterPlayer = state.players.find((item) => item.id === spot.playerId);
          return { playerId: spot.playerId, name: rosterPlayer?.name || "Unknown player", position: rosterPlayer?.position || "FLEX", nflTeam: rosterPlayer?.nflTeam || "FA", price: spot.price };
        })
      }))
    };
    await phoneRoomTransport.publishState(phoneRoom.mode === "remote" ? { room: publicRoom } : {
      roomId: phoneRoom.roomId,
      hostKey: phoneRoom.hostKey,
      auction: publicRoom.auction,
      teams: publicRoom.teams
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
  if (phoneRoom.mode === "remote") throw new Error("Remote claims are reset by closing and creating a new relay room.");
  const snapshot = await phoneRoomTransport.resetClaims({ roomId: phoneRoom.roomId, hostKey: phoneRoom.hostKey });
  applyPhoneRoomSnapshot(snapshot);
  render();
  showNotice({ kind: "success", message: "All phones were disconnected from their teams." });
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
  state = createFantasyProsDraft(state);
  persistDraft();
  render();
  scheduleAutoNomination();
  showNotice({ kind: "success", message: `Loaded ${fantasyProsPlayers.length} FantasyPros CSV players and values. The draft is ready.` });
}

function createFantasyProsDraft(baseState = null) {
  const config = baseState?.config || {};
  const teams = baseState?.teams?.length ? baseState.teams : makeTeams();
  return createDraft({
    players: fantasyProsPlayers,
    teams: teams.map((team) => ({ ...team, roster: [] })),
    budget: config.budget ?? 200,
    rosterSize: config.rosterSize ?? 15,
    increment: config.increment ?? 1,
    rosterRequirements: config.rosterRequirements || STANDARD_ROSTER_REQUIREMENTS,
    countdownOnceSeconds: config.countdownOnceSeconds,
    countdownTwiceSeconds: config.countdownTwiceSeconds,
    nominationOrder: baseState?.nomination?.order
  });
}

function hasFictionalPlayers(draft) {
  return Boolean(draft?.players?.some((player) => String(player?.id || "").startsWith("demo-")));
}

function withoutMarketValues(draft) {
  if (!draft?.players) return draft;
  return {
    ...draft,
    players: draft.players.map(({ marketAverage, marketProjected, marketDraftedPercentage, marketSource, ...player }) => player)
  };
}

function update(nextState, message) {
  state = nextState;
  persistDraft();
  render();
  if (message) showNotice({ kind: "success", message });
}

function toggleEmergencyLock() {
  clearTimer();
  clearAutoDraftTimer();
  stopAuctioneer();
  if (!emergencyLocked) {
    state = pauseAuction(state);
    emergencyLocked = true;
    persistDraft();
    showNotice({ kind: "error", message: "Emergency lock is active. Bidding is paused and sale corrections are enabled." });
  } else {
    emergencyLocked = false;
    render();
  }
}

function correctHistoricalSale(saleId) {
  if (!emergencyLocked) throw new Error("Activate the emergency lock before correcting a sale.");
  const sale = state.sales.find((item) => item.id === saleId);
  if (!sale) throw new Error("That sale no longer exists.");
  const teamOptions = state.teams.map((team, index) => `${index + 1}: ${team.name}`).join("\n");
  const answer = window.prompt(`Enter buyer number and price, such as 3,42. Enter RETURN to put the player back in the pool.\n\n${teamOptions}`, `${state.teams.findIndex((team) => team.id === sale.teamId) + 1},${sale.amount}`);
  if (answer == null) return;
  if (answer.trim().toUpperCase() === "RETURN") {
    update(correctSale(state, saleId, { returnToPool: true }), "Sale removed and player returned to the pool.");
    return;
  }
  const [teamNumber, price] = answer.split(",").map((value) => Number(value.trim()));
  const team = state.teams[teamNumber - 1];
  update(correctSale(state, saleId, { teamId: team?.id, amount: price }), "Sale corrected and all budgets and rosters rebuilt.");
}

function showNotice(nextNotice) {
  notice = nextNotice;
  render();
  if (notice) window.setTimeout(() => { if (notice === nextNotice) { notice = null; render(); } }, 4500);
}

function persistDraft() {
  const snapshot = structuredClone(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  draftSavePromise = draftSavePromise.catch(() => {}).then(async () => {
    const response = await hostFetch("/api/draft-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: snapshot, expectedRevision: draftRevision })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Draft saving failed.");
    draftRevision = payload.revision;
    durableSaveFailed = false;
    localStorage.removeItem(STORAGE_KEY);
  }).catch((error) => {
    durableSaveFailed = true;
    clearTimer();
    clearAutoDraftTimer();
    if (isLiveAuctionPhase(state.auction.phase)) state = pauseAuction(state);
    notice = { kind: "error", message: `${error.message} The auction is paused; export an emergency backup before continuing.` };
    render();
  });
  schedulePhoneRoomSync();
}

function exportDraftBackup() {
  const backup = { format: "sun-god-emergency-backup-v1", exportedAt: Date.now(), revision: draftRevision, saveFailed: durableSaveFailed, state };
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `sun-god-draft-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importDraftBackup(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const response = await hostFetch("/api/draft-backup/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(backup)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The backup could not be restored.");
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  } catch (error) {
    showNotice({ kind: "error", message: error.message });
  }
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
    ? "OpenAI edits each joke against the player, price, and draft-sheet value."
    : "Lucy uses price-aware built-in jokes when OpenAI is unavailable.";
}

function restoreDraft(source = undefined) {
  try {
    const restored = source === undefined ? JSON.parse(localStorage.getItem(STORAGE_KEY)) : structuredClone(source);
    if (!restored) return null;
    restored.config = {
      ...restored.config,
      rosterRequirements: Object.fromEntries(ROSTER_POSITIONS.map((position) => [position, Number(restored.config?.rosterRequirements?.[position]) || 0])),
      countdownOnceSeconds: normalizeCountdownSeconds(restored.config?.countdownOnceSeconds, DEFAULT_COUNTDOWN_SECONDS.once),
      countdownTwiceSeconds: normalizeCountdownSeconds(restored.config?.countdownTwiceSeconds, DEFAULT_COUNTDOWN_SECONDS.twice)
    };
    restored.teams = (restored.teams || []).map((team) => ({ ...team, controller: autoTeamController(team.controller) }));
    restored.nomination ||= { order: restored.teams.map((team) => team.id), currentIndex: 0 };
    restored.auction = { nominatorTeamId: null, autoIntents: {}, autoIntentStatus: "idle", ...restored.auction };
    validateDraftState(restored);
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
      energy: Math.min(3, Math.max(1, Number(saved?.energy) || 2)),
      speed: normalizeAuctioneerSpeed(saved?.speed)
    };
  } catch { return { enabled: true, playByPlayEnabled: true, roastingEnabled: true, provider: "auto", personality: "classic", energy: 2, speed: "normal" }; }
}

async function loadHostSession() {
  if (globalThis.sunGod?.hostToken) return globalThis.sunGod.hostToken;
  const response = await fetch("/api/host-session", { method: "POST", cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token) throw new Error(payload.error || "Open the commissioner app on this Mac to continue.");
  return payload.token;
}

async function loadDurableDraft() {
  const response = await hostFetch("/api/draft-state", { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Durable draft storage is unavailable.");
  return payload;
}

function hostFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${hostToken}`);
  return fetch(input, { ...init, headers });
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
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 3 3m-6 0 3 3"/>',
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
