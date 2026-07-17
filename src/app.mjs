import { seedPlayers, makeTeams } from "./data.mjs";
import { parseSpokenBid } from "./bid-voice.mjs";
import { hasPotentialBidSignal, normalizeCloudAuctionIntent } from "./auction-intent.mjs";
import { RealtimeTranscriber } from "./realtime-transcriber.mjs";
import { VoiceIdentityService } from "./voice-identity.mjs";
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
  maxBidForTeam
} from "./domain.mjs";

const STORAGE_KEY = "gavel-draft-v1";
const CLOUD_INTERPRETER_STORAGE_KEY = "gavel-cloud-interpreter-enabled";
const COUNTDOWN_DELAYS = { open: 8000, once: 5200, twice: 4200 };
const app = document.querySelector("#app");
let state = restoreDraft() || createDraft({ players: seedPlayers, teams: makeTeams(), budget: 200, rosterSize: 15 });
let armedTeamId = state.teams[0]?.id || null;
let micEnabled = false;
let cameraEnabled = false;
let voiceEnabled = true;
let autoEnabled = true;
let cameraStream = null;
let countdownTimer = null;
let lastTranscript = "Say “bid” or use a team button";
let notice = null;
let voiceDialogOpen = false;
let pendingVoiceBid = null;
let cloudInterpreter = {
  status: "checking",
  enabled: localStorage.getItem(CLOUD_INTERPRETER_STORAGE_KEY) !== "false",
  model: null,
  message: "Checking whether the cloud bid interpreter is configured."
};
let transcriptionService = {
  status: "checking",
  listenerStatus: "idle",
  model: null,
  message: "Checking whether OpenAI live transcription is configured.",
  error: null
};
let voiceState = {
  status: "ready",
  error: null,
  profileTeamIds: [],
  enrollingTeamId: null,
  enrollmentProgress: 0,
  isRecognizing: false,
  latestScores: {}
};
const voiceIdentity = new VoiceIdentityService({
  onStateChange: (snapshot) => {
    const structuralChange = snapshot.status !== voiceState.status
      || snapshot.enrollingTeamId !== voiceState.enrollingTeamId
      || snapshot.profileTeamIds.join(",") !== voiceState.profileTeamIds.join(",");
    voiceState = snapshot;
    if (structuralChange) render();
    else refreshVoiceIndicators();
  },
  onScores: (scores) => {
    voiceState.latestScores = scores;
    refreshVoiceIndicators();
  }
});
const transcriber = new RealtimeTranscriber({
  onTranscript: async (transcript) => {
    lastTranscript = `“${transcript}”`;
    await handleVoiceCommand(transcript);
  },
  onInterim: (transcript) => {
    lastTranscript = `“${transcript}…”`;
    refreshTranscript();
  },
  onStateChange: (snapshot) => {
    transcriptionService = { ...transcriptionService, listenerStatus: snapshot.status, error: snapshot.error || null };
    render();
  },
  onError: (message) => {
    if (!micEnabled) return;
    micEnabled = false;
    void voiceIdentity.stopRecognition();
    void transcriber.stop();
    showNotice({ kind: "error", message });
  }
});

render();
wireGlobalEvents();
voiceIdentity.loadStoredProfiles().catch((error) => showNotice({ kind: "error", message: error.message }));
refreshCloudInterpreter();
refreshTranscriptionService();

function render() {
  const player = currentPlayer(state);
  const highBidder = state.teams.find((team) => team.id === state.auction.highBidderId);
  const available = state.players.filter((item) => item.status === "available");
  const nextPlayers = state.queue
    .map((id) => state.players.find((item) => item.id === id))
    .filter((item) => item?.status === "available" && item.id !== player?.id)
    .slice(0, 7);

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <button class="brand" data-action="setup" aria-label="Open league setup">
          <span class="brand-mark">G</span>
          <span><strong>Gavel</strong><small>AI AUCTIONEER</small></span>
        </button>
        <div class="room-state">
          <span class="live-dot ${["open", "once", "twice"].includes(state.auction.phase) ? "is-live" : ""}"></span>
          <span>${phaseLabel(state.auction.phase)}</span>
          <span class="room-divider"></span>
          <span>${state.sales.length} sold</span>
          <span>${available.length} available</span>
        </div>
        <div class="device-controls">
          <button class="device-button ${micEnabled ? "is-on" : ""}" data-action="microphone" title="Toggle OpenAI bid listening">${icon("mic")} <span>${microphoneLabel()}</span></button>
          <button class="device-button voice-id-button ${voiceState.isRecognizing ? "is-on" : ""}" data-action="voice-setup" title="Enroll and manage manager voices">${icon("fingerprint")} <span id="voice-id-label">${voiceBadgeLabel()}</span></button>
          <button class="device-button ${cameraEnabled ? "is-on" : ""}" data-action="camera" title="Toggle room camera">${icon("camera")} <span>${cameraEnabled ? "Camera on" : "Camera off"}</span></button>
          <button class="icon-button ${voiceEnabled ? "is-on" : ""}" data-action="voice" title="Toggle auctioneer voice">${icon("volume")}</button>
          <button class="icon-button" data-action="setup" title="League setup">${icon("settings")}</button>
        </div>
      </header>

      ${notice ? `<div class="notice ${notice.kind}"><span>${escapeHtml(notice.message)}</span><button data-action="dismiss-notice">×</button></div>` : ""}
      ${pendingVoiceBid ? voiceConfirmation() : ""}

      <main class="draft-grid">
        <section class="camera-panel panel">
          <div class="panel-heading">
            <div><span class="eyebrow">ROOM VIEW</span><h2>Bidder camera</h2></div>
            <span class="privacy-chip">ON DEVICE</span>
          </div>
          <div class="video-wrap ${cameraEnabled ? "camera-active" : ""}">
            <video id="room-video" autoplay muted playsinline></video>
            <div class="video-empty">
              ${icon("camera")}
              <strong>Room camera is off</strong>
              <span>Use it as a visual aid for who raised the bid.</span>
              <button data-action="camera">Enable camera</button>
            </div>
            <div class="seat-overlay">
              <span>LEFT</span><span>CENTER</span><span>RIGHT</span>
            </div>
            <div class="camera-status"><i></i>${cameraEnabled ? "LOCAL PREVIEW" : "STANDBY"}</div>
          </div>
          <div class="listener-card ${micEnabled ? "is-listening" : ""}">
            <div class="waveform">${Array.from({ length: 13 }, (_, i) => `<i style="--i:${i}"></i>`).join("")}</div>
            <div><small>${micEnabled ? "OPENAI HEARD IN THE ROOM" : "VOICE INPUT"}</small><p id="live-transcript">${escapeHtml(lastTranscript)}</p></div>
          </div>
          <p class="camera-note">Camera stays in this browser. The microphone stream goes to OpenAI only while listening; local voiceprints still identify managers automatically.</p>
        </section>

        <section class="auction-stage">
          <div class="stage-glow"></div>
          ${player ? playerCard(player, highBidder) : emptyStage()}
        </section>

        <aside class="queue-panel panel">
          <div class="panel-heading">
            <div><span class="eyebrow">ON DECK</span><h2>Player board</h2></div>
            <label class="search-box">${icon("search")}<input id="player-search" placeholder="Find player" autocomplete="off" /></label>
          </div>
          <div id="search-results" class="search-results"></div>
          <div class="queue-list">
            ${nextPlayers.length ? nextPlayers.map((item, index) => queueRow(item, index)).join("") : `<p class="empty-copy">No players left in the queue.</p>`}
          </div>
          <div class="queue-actions">
            <button class="text-button" data-action="import">${icon("upload")} Import player CSV</button>
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
          <div class="keyboard-hint"><kbd>1</kbd>–<kbd>${Math.min(9, state.teams.length)}</kbd> quick bid <span>•</span> Click a team once to arm it for a spoken “bid”</div>
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
    <dialog id="voice-dialog" class="voice-dialog">${voiceSetupDialog()}</dialog>
  `;

  if (cameraEnabled && cameraStream) {
    const video = document.querySelector("#room-video");
    if (video) video.srcObject = cameraStream;
  }
  if (voiceDialogOpen) {
    const dialog = document.querySelector("#voice-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }
  refreshVoiceIndicators();
}

function playerCard(player, highBidder) {
  const canOpen = ["ready", "paused"].includes(state.auction.phase);
  const inProgress = ["open", "once", "twice"].includes(state.auction.phase);
  const done = ["sold", "passed"].includes(state.auction.phase);
  const statusCopy = state.auction.phase === "sold"
    ? `SOLD TO ${highBidder?.name?.toUpperCase()}`
    : state.auction.phase === "passed" ? "NO SALE" : phaseLabel(state.auction.phase).toUpperCase();
  return `
    <div class="lot-number">LOT ${String(state.sales.length + 1).padStart(2, "0")}</div>
    <div class="position-badge">${player.position}</div>
    <div class="player-identity">
      <span class="nfl-team">${player.nflTeam}</span>
      <h1>${escapeHtml(player.name)}</h1>
      <p>Suggested value <strong>$${player.suggestedValue}</strong></p>
    </div>
    <div class="bid-display ${state.auction.amount ? "has-bid" : ""}">
      <span class="bid-label">${state.auction.amount ? "CURRENT BID" : "OPENING BID"}</span>
      <div class="bid-number"><sup>$</sup>${state.auction.amount || 1}</div>
      <div class="high-bidder">
        ${highBidder ? `<i style="background:${highBidder.color}"></i><span>${escapeHtml(highBidder.name)}<small>${escapeHtml(highBidder.manager)}</small></span>` : `<span>Waiting for the room</span>`}
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

function emptyStage() {
  return `<div class="empty-stage"><span class="brand-mark large">G</span><span class="eyebrow">THE ROOM IS READY</span><h1>Nominate the first player</h1><p>Choose a player from the board to begin the draft.</p></div>`;
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
  const isArmed = team.id === armedTeamId;
  const isEnrolled = voiceState.profileTeamIds.includes(team.id);
  const voiceScore = voiceState.latestScores[team.id] || 0;
  const maxBid = maxBidForTeam(state, team.id);
  const disabled = !["open", "once", "twice"].includes(state.auction.phase) || isHigh || maxBid < Math.max(1, state.auction.amount + state.config.increment);
  return `<button class="team-bid ${isHigh ? "is-high" : ""} ${isArmed ? "is-armed" : ""}" style="--team:${team.color}" data-action="bid" data-team-id="${team.id}" ${disabled ? "disabled" : ""}>
    <span class="team-key">${index < 9 ? index + 1 : ""}</span>
    <span class="team-swatch"></span>
    <span class="team-copy"><strong>${escapeHtml(team.name)}</strong><small>${escapeHtml(team.manager)} · ${team.roster.length}/${state.config.rosterSize} players</small></span>
    <span class="team-money"><strong>$${team.budget}</strong><small>max $${maxBid}</small></span>
    <span class="armed-label">${isHigh ? "HIGH BID" : isArmed ? "VOICE ARMED" : "+ BID"}</span>
    <span class="voice-profile-dot ${isEnrolled ? "is-enrolled" : ""}" data-voice-dot="${team.id}" style="--voice-score:${Math.round(voiceScore * 100)}%" title="${isEnrolled ? `Voice enrolled · ${Math.round(voiceScore * 100)}% last match` : "Voice not enrolled"}">${icon("fingerprint")}</span>
  </button>`;
}

function saleRow(sale) {
  const player = state.players.find((item) => item.id === sale.playerId);
  const team = state.teams.find((item) => item.id === sale.teamId);
  return `<div class="sale-row"><span class="mini-position ${player.position.toLowerCase()}">${player.position}</span><span><strong>${escapeHtml(player.name)}</strong><small>${escapeHtml(team.name)}</small></span><b>$${sale.amount}</b></div>`;
}

function setupDialog() {
  return `<form id="setup-form" method="dialog">
    <div class="dialog-head"><div><span class="eyebrow">LEAGUE CONTROL</span><h2>Start a new draft</h2></div><button type="button" data-action="close-setup" class="dialog-close" aria-label="Close">×</button></div>
    <p>Reset the room with a standard salary-cap format. Enter one team per line as <strong>Team name | Manager</strong>.</p>
    <div class="form-grid">
      <label>Teams<input name="teamCount" type="number" min="2" max="12" value="${state.teams.length}" required /></label>
      <label>Budget per team<input name="budget" type="number" min="20" max="1000" value="${state.config.budget}" required /></label>
      <label>Roster size<input name="rosterSize" type="number" min="1" max="30" value="${state.config.rosterSize}" required /></label>
      <label>Bid increment<input name="increment" type="number" min="1" max="20" value="${state.config.increment}" required /></label>
      <label class="team-name-field">Teams and managers<textarea name="teamNames" rows="${Math.min(12, Math.max(4, state.teams.length))}">${escapeHtml(state.teams.map((team) => `${team.name} | ${team.manager}`).join("\n"))}</textarea></label>
    </div>
    <div class="dialog-actions"><button type="button" data-action="close-setup" class="secondary-action">Cancel</button><button type="submit" class="primary-action">Create draft room</button></div>
  </form>`;
}

function voiceSetupDialog() {
  const connected = voiceIdentity.isSupported && voiceState.status !== "unsupported";
  const enrolledCount = state.teams.filter((team) => voiceState.profileTeamIds.includes(team.id)).length;
  return `<div class="voice-setup">
    <div class="dialog-head"><div><span class="eyebrow">PRIVATE VOICE CHECK-IN</span><h2>Recognize every manager</h2></div><button type="button" data-action="close-voice-setup" class="dialog-close" aria-label="Close">×</button></div>
    <p class="voice-intro">Each manager speaks for six seconds to create a local voiceprint. Raw enrollment audio is discarded after local processing. When the main microphone is on, detected speech is transcribed by OpenAI; camera video and voiceprints stay on this Mac. The bid interpreter receives only the final text plus auction context. Always get everyone’s consent before enrolling.</p>
    ${transcriptionCard()}
    ${cloudInterpreterCard()}
    ${!voiceIdentity.isSupported ? `<div class="voice-error">Speaker recognition is unavailable in this browser. Use a current version of Chrome, Safari, Firefox, or Edge.</div>` : ""}
    ${connected ? `<div class="voice-ready-banner"><span>${icon("shield")} LOCAL SPEAKER ENGINE READY</span><b>${enrolledCount}/${state.teams.length} managers enrolled</b></div>` : ""}
    ${voiceState.error ? `<div class="voice-error">${escapeHtml(voiceState.error)}</div>` : ""}
    <div class="enrollment-list ${connected ? "" : "is-locked"}">
      ${state.teams.map((team) => voiceEnrollmentRow(team, connected)).join("")}
    </div>
    <div class="voice-footer">
    <span>Voiceprints are biometric identifiers stored only in this browser’s IndexedDB on this Mac.</span>
      ${enrolledCount ? `<button type="button" class="text-button danger" data-action="delete-all-voices">Delete all voiceprints</button>` : ""}
    </div>
  </div>`;
}

function transcriptionCard() {
  const ready = transcriptionService.status === "ready";
  const listening = transcriptionService.listenerStatus === "listening";
  const summary = transcriptionService.error
    || (!ready ? transcriptionService.message : listening
      ? `OpenAI ${transcriptionService.model} is transcribing live microphone audio.`
      : `OpenAI ${transcriptionService.model} will transcribe the room when the mic is on.`);
  return `<div class="cloud-interpreter-card ${listening ? "is-active" : ""}">
    <div><span class="eyebrow">OPENAI LIVE TRANSCRIPTION</span><strong>${listening ? "LISTENING" : ready ? "READY" : "NOT CONFIGURED"}</strong><p>${escapeHtml(summary)}</p></div>
  </div>`;
}

function cloudInterpreterCard() {
  const ready = cloudInterpreter.status === "ready";
  const active = ready && cloudInterpreter.enabled;
  const summary = !ready
    ? cloudInterpreter.message
    : active
      ? `OpenAI ${cloudInterpreter.model} is correcting likely transcription mistakes before a bid is applied.`
      : "Cloud interpretation is off. Gavel will use its on-device phrase parser instead.";
  return `<div class="cloud-interpreter-card ${active ? "is-active" : ""}">
    <div><span class="eyebrow">CLOUD BID INTERPRETER</span><strong>${active ? "ON · READY" : ready ? "OFF" : "NOT CONFIGURED"}</strong><p>${escapeHtml(summary)}</p></div>
    <button type="button" class="secondary-action compact" data-action="toggle-cloud-interpreter" ${ready ? "" : "disabled"}>${active ? "Turn off" : "Turn on"}</button>
  </div>`;
}

function voiceEnrollmentRow(team, connected) {
  const enrolled = voiceState.profileTeamIds.includes(team.id);
  const active = voiceState.enrollingTeamId === team.id;
  const score = voiceState.latestScores[team.id] || 0;
  return `<div class="enrollment-row ${active ? "is-active" : ""}">
    <span class="team-swatch" style="background:${team.color}"></span>
    <span class="enrollment-person"><strong>${escapeHtml(team.manager)}</strong><small>${escapeHtml(team.name)}</small></span>
    <span class="enrollment-status ${enrolled ? "is-enrolled" : ""}">${enrolled ? `${icon("check")} Enrolled` : "Not enrolled"}</span>
    ${active ? `<div class="enrollment-progress"><i data-enrollment-bar style="width:${voiceState.enrollmentProgress}%"></i></div><b class="progress-number" data-enrollment-progress>${voiceState.enrollmentProgress}%</b>` : `<span class="live-score" data-voice-score="${team.id}">${voiceState.isRecognizing && enrolled ? `${Math.round(score * 100)}% match` : ""}</span>`}
    <div class="enrollment-actions">
      ${active ? `<button type="button" class="secondary-action compact" data-action="cancel-enrollment">Cancel</button>` : `<button type="button" class="secondary-action compact" data-action="enroll-voice" data-team-id="${team.id}" ${connected ? "" : "disabled"}>${enrolled ? "Re-enroll" : "Enroll voice"}</button>`}
      ${enrolled && !active ? `<button type="button" class="icon-button compact" data-action="delete-voice" data-team-id="${team.id}" title="Delete ${escapeHtml(team.manager)}'s voiceprint">×</button>` : ""}
    </div>
    ${active ? `<p class="enrollment-prompt">Keep speaking naturally in a quiet room until the meter reaches 100%. Try: “My name is ${escapeHtml(team.manager)}, and when I want a player I will say bid during this auction.”</p>` : ""}
  </div>`;
}

function voiceConfirmation() {
  if (pendingVoiceBid.resolving) {
    const copy = pendingVoiceBid.stage === "interpreting"
      ? "Interpreting the likely bid, then matching the speaker…"
      : "Matching the speaker against local voiceprints…";
    return `<div class="voice-confirmation is-resolving">
      <div>${icon("fingerprint")}<span><small>VOICE BID HEARD · AUCTION PAUSED</small><strong>${escapeHtml(pendingVoiceBid.transcript)}</strong></span></div>
      <p>${copy}</p>
    </div>`;
  }
  const candidates = pendingVoiceBid.candidates.length
    ? pendingVoiceBid.candidates
    : state.teams.map((team) => ({ teamId: team.id, confidence: 0 }));
  return `<div class="voice-confirmation">
    <div>${icon("alert")}<span><small>VOICE NEEDS CONFIRMATION</small><strong>${escapeHtml(pendingVoiceBid.transcript)}</strong></span></div>
    <p>Who made that bid?</p>
    <div class="voice-candidates">
      ${candidates.slice(0, 4).map((candidate) => {
        const team = state.teams.find((item) => item.id === candidate.teamId);
        if (!team) return "";
        return `<button data-action="confirm-voice-bid" data-team-id="${team.id}"><i style="background:${team.color}"></i>${escapeHtml(team.manager)}${candidate.confidence ? `<small>${Math.round(candidate.confidence * 100)}%</small>` : ""}</button>`;
      }).join("")}
      <button class="reject" data-action="reject-voice-bid">Not a bid</button>
    </div>
  </div>`;
}

function wireGlobalEvents() {
  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    try {
      if (action === "setup") return document.querySelector("#setup-dialog")?.showModal();
      if (action === "close-setup") return document.querySelector("#setup-dialog")?.close();
      if (action === "voice-setup") { voiceDialogOpen = true; render(); return; }
      if (action === "close-voice-setup") { voiceDialogOpen = false; render(); return; }
      if (action === "enroll-voice") return beginVoiceEnrollment(button.dataset.teamId);
      if (action === "cancel-enrollment") return voiceIdentity.cancelEnrollment();
      if (action === "delete-voice") return voiceIdentity.deleteProfile(button.dataset.teamId);
      if (action === "delete-all-voices") return voiceIdentity.deleteAllProfiles();
      if (action === "toggle-cloud-interpreter") return toggleCloudInterpreter();
      if (action === "confirm-voice-bid") return confirmPendingVoiceBid(button.dataset.teamId);
      if (action === "reject-voice-bid") { pendingVoiceBid = null; render(); scheduleCountdown(); return; }
      if (action === "dismiss-notice") return showNotice(null);
      if (action === "microphone") return toggleMicrophone();
      if (action === "camera") return toggleCamera();
      if (action === "voice") { voiceEnabled = !voiceEnabled; if (!voiceEnabled) speechSynthesis.cancel(); render(); return; }
      if (action === "nominate") return update(nominatePlayer(state, button.dataset.playerId));
      if (action === "open") return beginAuction();
      if (action === "pause") { clearTimer(); speechSynthesis.cancel(); return update(pauseAuction(state)); }
      if (action === "advance") return runCountdownStep();
      if (action === "next") return update(moveToNextPlayer(state));
      if (action === "bid") { armedTeamId = button.dataset.teamId; return submitBid(button.dataset.teamId); }
      if (action === "undo") { clearTimer(); return update(undoLastSale(state), "Last sale reversed."); }
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
    const rosterSize = Number(data.get("rosterSize"));
    const increment = Number(data.get("increment"));
    const teamLines = String(data.get("teamNames") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const teams = makeTeams(teamCount, budget).map((team, index) => {
      const [name, manager] = (teamLines[index] || "").split("|").map((part) => part?.trim());
      return { ...team, name: name || team.name, manager: manager || team.manager };
    });
    state = createDraft({ players: seedPlayers, teams, budget, rosterSize, increment });
    armedTeamId = state.teams[0].id;
    persistDraft();
    document.querySelector("#setup-dialog")?.close();
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea")) return;
    const teamIndex = Number(event.key) - 1;
    if (teamIndex >= 0 && teamIndex < Math.min(9, state.teams.length)) {
      armedTeamId = state.teams[teamIndex].id;
      submitBid(armedTeamId);
    }
    if (event.code === "Space" && ["open", "once", "twice"].includes(state.auction.phase)) {
      event.preventDefault();
      runCountdownStep();
    }
  });
}

function beginAuction() {
  clearTimer();
  state = openAuction(state);
  persistDraft();
  render();
  const player = currentPlayer(state);
  speak(`All right, next up is ${player.name}, ${player.position}, ${player.nflTeam}. We will start at one dollar. Who gives me one?`, scheduleCountdown);
}

function submitBid(teamId, voiceAmount = null) {
  const input = document.querySelector("#manual-amount");
  const amount = voiceAmount ?? (input ? Number(input.value) : null);
  clearTimer();
  state = placeBid(state, teamId, amount);
  persistDraft();
  render();
  const team = state.teams.find((item) => item.id === teamId);
  const next = state.auction.amount + state.config.increment;
  speak(`${state.auction.amount} dollars, with ${team.manager}. Do I hear ${next}?`, scheduleCountdown);
}

function runCountdownStep() {
  clearTimer();
  const before = state.auction.phase;
  state = advanceCountdown(state);
  persistDraft();
  render();
  if (state.auction.phase === "once") speak(`${state.auction.amount} dollars, going once.`, scheduleCountdown);
  else if (state.auction.phase === "twice") speak(`Going twice. Fair warning.`, scheduleCountdown);
  else if (state.auction.phase === "sold") {
    const player = currentPlayer(state);
    const team = state.teams.find((item) => item.id === state.auction.highBidderId);
    speak(`Sold! ${player.name} to ${team.name}, managed by ${team.manager}, for ${state.auction.amount} dollars.`);
  } else if (state.auction.phase === "passed" && before === "open") {
    speak(`No interest. ${currentPlayer(state).name} goes back to the player pool.`);
  }
}

function scheduleCountdown() {
  clearTimer();
  if (!autoEnabled || !["open", "once", "twice"].includes(state.auction.phase)) return;
  const delay = COUNTDOWN_DELAYS[state.auction.phase];
  countdownTimer = window.setTimeout(runCountdownStep, delay);
}

function clearTimer() {
  if (countdownTimer) window.clearTimeout(countdownTimer);
  countdownTimer = null;
}

function speak(text, onDone) {
  if (!voiceEnabled || !("speechSynthesis" in window)) { onDone?.(); return; }
  const shouldResumeMic = micEnabled;
  const shouldResumeIdentity = voiceState.isRecognizing;
  if (shouldResumeMic) void transcriber.stop();
  if (shouldResumeIdentity) void voiceIdentity.stopRecognition();
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.08;
  utterance.pitch = 0.84;
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => /Daniel|Alex|Google UK English Male/i.test(voice.name)) || voices.find((voice) => voice.lang.startsWith("en")) || null;
  utterance.onend = () => {
    if (shouldResumeMic && micEnabled) startLiveTranscription().catch((error) => handleTranscriptionFailure(error));
    if (shouldResumeIdentity && micEnabled) voiceIdentity.startRecognition().catch(() => {});
    onDone?.();
  };
  utterance.onerror = () => {
    if (shouldResumeMic && micEnabled) startLiveTranscription().catch((error) => handleTranscriptionFailure(error));
    if (shouldResumeIdentity && micEnabled) voiceIdentity.startRecognition().catch(() => {});
    onDone?.();
  };
  speechSynthesis.speak(utterance);
}

async function toggleMicrophone() {
  if (!transcriber.isSupported) return showNotice({ kind: "error", message: "OpenAI live transcription needs a current browser with microphone and WebSocket support." });
  if (transcriptionService.status === "unavailable") return showNotice({ kind: "error", message: transcriptionService.message });
  if (micEnabled) {
    micEnabled = false;
    await transcriber.stop();
    await voiceIdentity.stopRecognition();
    render();
    return;
  }
  micEnabled = true;
  try {
    await startLiveTranscription();
    voiceIdentity.startRecognition().catch((error) => showNotice({ kind: "error", message: `Voice identity could not start: ${error.message}` }));
  } catch (error) {
    handleTranscriptionFailure(error);
  }
  render();
}

async function startLiveTranscription() {
  if (!micEnabled) return;
  await transcriber.start();
}

function handleTranscriptionFailure(error) {
  micEnabled = false;
  void transcriber.stop();
  void voiceIdentity.stopRecognition();
  showNotice({ kind: "error", message: `OpenAI transcription could not start: ${error.message}` });
}

async function handleVoiceCommand(transcript) {
  if (pendingVoiceBid) return;
  let command = parseSpokenBid(transcript);
  let namedTeam = findNamedTeam(command.normalized);
  if (!hasPotentialBidSignal(command, namedTeam)) {
    render();
    return;
  }

  const canIdentifySpeaker = voiceState.isRecognizing && voiceState.profileTeamIds.length;
  let identityPromise = null;
  let resolvingBid = null;

  if (cloudInterpreter.enabled && cloudInterpreter.status === "ready") {
    clearTimer();
    resolvingBid = {
      transcript: `“${transcript}”`,
      amount: command.amount,
      candidates: [],
      resolving: true,
      stage: "interpreting"
    };
    pendingVoiceBid = resolvingBid;
    render();
    if (canIdentifySpeaker) identityPromise = voiceIdentity.identifyRecent();

    try {
      const interpretation = await interpretCloudAuctionIntent(transcript);
      if (pendingVoiceBid !== resolvingBid) return;
      if (interpretation.intent === "ignore") {
        pendingVoiceBid = null;
        render();
        scheduleCountdown();
        return;
      }
      command = {
        ...command,
        isBid: true,
        amount: interpretation.amount ?? command.amount
      };
      namedTeam = state.teams.find((team) => team.id === interpretation.managerId) || namedTeam;
      resolvingBid.amount = command.amount;
    } catch {
      // Local parsing remains the safe fallback if the cloud call is unavailable or slow.
    }
  }

  const requested = command.amount;
  if (!command.isBid && !(namedTeam && requested !== null)) {
    if (pendingVoiceBid === resolvingBid) {
      pendingVoiceBid = null;
      render();
      scheduleCountdown();
    }
    return;
  }

  if (canIdentifySpeaker) {
    clearTimer();
    resolvingBid ||= {
      transcript: `“${transcript}”`,
      amount: requested,
      candidates: [],
      resolving: true,
      stage: "identifying"
    };
    resolvingBid.amount = requested;
    resolvingBid.stage = "identifying";
    pendingVoiceBid = resolvingBid;
    render();
    const identity = await (identityPromise || voiceIdentity.identifyRecent());
    if (pendingVoiceBid !== resolvingBid) return;
    const matchedTeamExists = state.teams.some((team) => team.id === identity.teamId);
    if (identity.status === "matched" && matchedTeamExists) {
      pendingVoiceBid = null;
      try { submitBid(identity.teamId, requested); }
      catch (error) { showNotice({ kind: "error", message: error.message }); }
      return;
    }
    pendingVoiceBid = {
      transcript: `“${transcript}”`,
      amount: requested,
      candidates: identity.candidates.filter((candidate) => state.teams.some((team) => team.id === candidate.teamId)),
      resolving: false
    };
    render();
    return;
  }

  if (pendingVoiceBid === resolvingBid) pendingVoiceBid = null;
  const teamId = namedTeam?.id || armedTeamId;
  if (!teamId) return showNotice({ kind: "error", message: "I heard a bid but could not identify a team. Arm a team first." });
  clearTimer();
  try { submitBid(teamId, requested); }
  catch (error) { showNotice({ kind: "error", message: error.message }); }
}

function findNamedTeam(normalized) {
  return state.teams.find((team) => {
    const words = `${team.name} ${team.manager}`.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
    return words.some((word) => normalized.includes(word));
  });
}

async function refreshCloudInterpreter() {
  try {
    const response = await fetch("/api/auction/interpret/status", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    cloudInterpreter = {
      ...cloudInterpreter,
      status: response.ok && payload.available ? "ready" : "unavailable",
      model: payload.model || null,
      message: payload.message || "Cloud bid interpretation is unavailable."
    };
  } catch {
    cloudInterpreter = {
      ...cloudInterpreter,
      status: "unavailable",
      model: null,
      message: "Cloud bid interpretation needs Gavel's local server."
    };
  }
  if (voiceDialogOpen) render();
}

async function refreshTranscriptionService() {
  try {
    const response = await fetch("/api/transcription/status", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    transcriptionService = {
      ...transcriptionService,
      status: response.ok && payload.available ? "ready" : "unavailable",
      model: payload.model || null,
      message: payload.message || "OpenAI live transcription is unavailable.",
      error: null
    };
  } catch {
    transcriptionService = {
      ...transcriptionService,
      status: "unavailable",
      model: null,
      message: "OpenAI live transcription needs Gavel's local server.",
      error: null
    };
  }
  render();
}

function toggleCloudInterpreter() {
  if (cloudInterpreter.status !== "ready") return;
  cloudInterpreter.enabled = !cloudInterpreter.enabled;
  localStorage.setItem(CLOUD_INTERPRETER_STORAGE_KEY, String(cloudInterpreter.enabled));
  render();
}

async function interpretCloudAuctionIntent(transcript) {
  const response = await fetch("/api/auction/interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript,
      auction: {
        currentBid: state.auction.amount,
        increment: state.config.increment,
        phase: state.auction.phase
      },
      teams: state.teams.map((team) => ({ id: team.id, name: team.name, manager: team.manager }))
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Cloud bid interpretation is unavailable.");
  return normalizeCloudAuctionIntent(payload, state.teams.map((team) => team.id));
}

async function beginVoiceEnrollment(teamId) {
  speechSynthesis.cancel();
  clearTimer();
  if (micEnabled) {
    micEnabled = false;
    await transcriber.stop();
  }
  try {
    await voiceIdentity.beginEnrollment(teamId);
  } catch (error) {
    showNotice({ kind: "error", message: error.message });
  }
}

function confirmPendingVoiceBid(teamId) {
  if (!pendingVoiceBid) return;
  const { amount } = pendingVoiceBid;
  pendingVoiceBid = null;
  render();
  try { submitBid(teamId, amount); }
  catch (error) { showNotice({ kind: "error", message: error.message }); scheduleCountdown(); }
}

async function toggleCamera() {
  if (cameraEnabled) {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    cameraEnabled = false;
    render();
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    cameraEnabled = true;
    render();
  } catch {
    showNotice({ kind: "error", message: "Camera permission was denied or no camera is available." });
  }
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
    state = createDraft({ players: imported, teams: state.teams.map((team) => ({ ...team, roster: [] })), budget: state.config.budget, rosterSize: state.config.rosterSize, increment: state.config.increment });
    persistDraft();
    render();
    showNotice({ kind: "success", message: `Imported ${imported.length} players and reset the draft.` });
  } catch (error) { showNotice({ kind: "error", message: error.message }); }
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
}

function voiceBadgeLabel() {
  const enrolled = state.teams.filter((team) => voiceState.profileTeamIds.includes(team.id)).length;
  if (voiceState.status === "enrolling") return `Enrolling ${enrolled}/${state.teams.length}`;
  if (voiceState.isRecognizing) return `Identifying ${enrolled}/${state.teams.length}`;
  return enrolled ? `Voices ${enrolled}/${state.teams.length}` : "Enroll voices";
}

function microphoneLabel() {
  if (transcriptionService.listenerStatus === "connecting") return "Connecting";
  if (micEnabled && transcriptionService.listenerStatus === "listening") return "Listening";
  return micEnabled ? "Starting" : "Mic off";
}

function refreshTranscript() {
  const transcript = document.querySelector("#live-transcript");
  if (transcript) transcript.textContent = lastTranscript;
}

function refreshVoiceIndicators() {
  const label = document.querySelector("#voice-id-label");
  if (label) label.textContent = voiceBadgeLabel();
  const progress = document.querySelector("[data-enrollment-progress]");
  const bar = document.querySelector("[data-enrollment-bar]");
  if (progress) progress.textContent = `${voiceState.enrollmentProgress}%`;
  if (bar) bar.style.width = `${voiceState.enrollmentProgress}%`;
  for (const team of state.teams) {
    const score = voiceState.latestScores[team.id] || 0;
    const scoreLabel = document.querySelector(`[data-voice-score="${team.id}"]`);
    if (scoreLabel) scoreLabel.textContent = voiceState.isRecognizing && voiceState.profileTeamIds.includes(team.id) ? `${Math.round(score * 100)}% last match` : "";
    const dot = document.querySelector(`[data-voice-dot="${team.id}"]`);
    if (dot) {
      dot.style.setProperty("--voice-score", `${Math.round(score * 100)}%`);
      dot.title = voiceState.profileTeamIds.includes(team.id) ? `Voice enrolled · ${Math.round(score * 100)}% last match` : "Voice not enrolled";
    }
  }
}

function restoreDraft() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

function phaseLabel(phase) {
  return ({ idle: "Room ready", ready: "Player nominated", open: "Bidding live", once: "Going once", twice: "Going twice", paused: "Auction paused", sold: "Player sold", passed: "No sale" })[phase] || phase;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function icon(name) {
  const paths = {
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
    camera: '<path d="M14.5 5 13 3H7L5.5 5H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-6.5Z"/><circle cx="10" cy="12" r="4"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    upload: '<path d="M12 16V3m0 0L7 8m5-5 5 5M4 14v6h16v-6"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    fingerprint: '<path d="M12 10a2 2 0 0 0-2 2c0 1.7-.3 4.2-1.8 6M15.5 13.5c-.2 2.7-1 5.2-2.4 7.2M6.5 16.5c.7-1.7.8-3.2.8-4.5a4.7 4.7 0 0 1 9.4 0c0 .9-.1 1.8-.2 2.7M4.2 12a7.8 7.8 0 0 1 15.6 0c0 3.5-.7 6.7-2 9M7.3 5.3A9.8 9.8 0 0 1 21.8 14M2.2 14A9.8 9.8 0 0 1 4 6.8"/>',
    shield: '<path d="M12 22s8-3.8 8-10V5l-8-3-8 3v7c0 6.2 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5m0 3h.01"/>'
  };
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
