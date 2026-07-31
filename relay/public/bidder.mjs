import { easyBidAmounts } from "./phone-bidding.mjs";
import { RelayRoomTransport } from "./room-transports.mjs";

const app = document.querySelector("#bidder-app");
const fragment = new URLSearchParams(window.location.hash.slice(1));
const pathParts = window.location.pathname.split("/").filter(Boolean);
const TOKEN_KEY = "sun-god-bidder-token";
const roomId = String(fragment.get("room") || pathParts.at(-1) || "").trim().toUpperCase();
const invitationSecret = String(fragment.get("invite") || "").trim();
let participantToken = localStorage.getItem(TOKEN_KEY) || createToken();
let selectedTeamId = roomId ? localStorage.getItem(teamStorageKey(roomId)) : null;
let room = null;
let claimedTeamIds = [];
let status = "loading";
let message = "Connecting to the draft room…";
let connectionState = "connecting";
let hostConnected = false;
let claimAuthenticated = false;
let restoreInFlight = false;
let releaseInFlight = false;
let sendingBid = false;
let roomTransport = null;
let activePhoneTab = "auction";

localStorage.setItem(TOKEN_KEY, participantToken);
render();
wireEvents();
if (/^[A-Z2-9]{6}$/.test(roomId) && invitationSecret.length >= 16) connectToRelay();
else {
  status = "error";
  message = "This remote invitation link is incomplete. Ask the commissioner for the current QR code or link.";
  render();
}

function wireEvents() {
  app.addEventListener("submit", async (event) => {
    if (event.target.id !== "custom-bid-form") return;
    event.preventDefault();
    const amount = Number(new FormData(event.target).get("amount"));
    try { await placePhoneBid(amount); }
    catch (error) { showMessage(error.message, "error"); }
  });

  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    try {
      if (button.dataset.action === "claim") return await claimTeam(button.dataset.teamId);
      if (button.dataset.action === "bid") return await placePhoneBid(button.dataset.amount == null ? null : Number(button.dataset.amount));
      if (button.dataset.action === "show-tab") {
        activePhoneTab = button.dataset.tab === "roster" ? "roster" : "auction";
        render();
        return;
      }
      if (button.dataset.action === "switch-team") return await releaseTeam();
      if (button.dataset.action === "retry") return connectToRelay();
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
}

function connectToRelay() {
  roomTransport?.close();
  connectionState = "connecting";
  claimAuthenticated = false;
  restoreInFlight = false;
  status = "loading";
  message = room ? "Reconnecting to the draft room…" : "Connecting to the draft room…";
  render();

  const transport = new RelayRoomTransport({
    baseUrl: window.location.origin,
    roomId,
    role: "participant",
    credential: invitationSecret
  });
  roomTransport = transport;
  transport.connect(
    (payload) => {
      if (roomTransport === transport) handleRelayMessage(payload);
    },
    (snapshot) => {
      if (roomTransport === transport) handleRelayStatus(snapshot);
    }
  );
}

function handleRelayStatus({ state: nextState, error }) {
  connectionState = nextState;
  if (nextState === "connected") {
    if (!room) {
      status = "loading";
      message = "Waiting for the commissioner to publish the draft room…";
    } else if (selectedTeamId && !claimAuthenticated) {
      void restoreSelectedTeam();
    } else {
      status = selectedTeamId ? "joined" : "choose";
      message = selectedTeamId ? connectionMessage() : "Choose your team";
    }
  } else if (nextState === "error") {
    status = "error";
    message = error || "The relay could not authenticate this invitation.";
    queueMicrotask(() => roomTransport?.close());
  } else {
    if (!room) status = "loading";
    message = nextState === "connecting" ? "Connecting to the draft room…" : "Reconnecting…";
  }
  render();
}

function handleRelayMessage(payload) {
  if (payload.type === "room.snapshot") {
    claimedTeamIds = Array.isArray(payload.claims) ? payload.claims : [];
    hostConnected = payload.hostConnected !== false;
    if (payload.room) {
      const claimed = new Set(claimedTeamIds);
      room = {
        ...payload.room,
        teams: (payload.room.teams || []).map((team) => ({ ...team, claimed: claimed.has(team.id) }))
      };
    }
    if (claimAuthenticated && selectedTeamId && !claimedTeamIds.includes(selectedTeamId) && !releaseInFlight) {
      localStorage.removeItem(teamStorageKey(roomId));
      selectedTeamId = null;
      claimAuthenticated = false;
      message = "The commissioner reset the connected phones. Choose your team again.";
    }
    if (room && selectedTeamId && connectionState === "connected" && !claimAuthenticated && !restoreInFlight && !releaseInFlight) {
      queueMicrotask(() => void restoreSelectedTeam());
    }
    status = !room ? "loading" : selectedTeamId ? claimAuthenticated ? "joined" : "loading" : "choose";
    if (claimAuthenticated) message = connectionMessage();
    render();
    return;
  }
  if (payload.type === "bid.received") {
    message = `Bid $${Number(payload.amount)} received by relay`;
    render();
    return;
  }
  if (payload.type === "bid.result") {
    const amount = Number(payload.amount || 0);
    message = payload.status === "accepted"
      ? `Bid $${amount} accepted`
      : payload.status === "outbid"
        ? `Bid $${amount} was beaten`
        : payload.status === "tie pending"
          ? `Tie at $${amount} — commissioner ruling`
          : String(payload.status || "Bid confirmed");
    if (payload.status === "accepted" && navigator.vibrate) navigator.vibrate([45, 35, 45]);
    render();
    return;
  }
  if (payload.type === "host.status") {
    hostConnected = payload.connected !== false;
    message = connectionMessage();
    render();
    return;
  }
  if (payload.type === "room.close") {
    status = "error";
    message = "This remote room has closed. Ask the commissioner for a new invitation link.";
    roomTransport?.close();
    render();
    return;
  }
  if (payload.type === "error") {
    message = payload.error || "The relay rejected that request.";
    if (navigator.vibrate) navigator.vibrate(120);
    render();
  }
}

async function restoreSelectedTeam() {
  if (!selectedTeamId || !room || connectionState !== "connected" || restoreInFlight || releaseInFlight) return;
  restoreInFlight = true;
  status = "loading";
  message = "Reconnecting your team…";
  render();
  try {
    await claimTeam(selectedTeamId, { restoring: true });
  } catch (error) {
    localStorage.removeItem(teamStorageKey(roomId));
    selectedTeamId = null;
    claimAuthenticated = false;
    status = "choose";
    message = error.message;
    render();
  } finally {
    restoreInFlight = false;
  }
}

async function claimTeam(teamId, { restoring = false } = {}) {
  if (connectionState !== "connected") throw new Error("The relay is still reconnecting.");
  if (!restoring) {
    message = "Claiming your team…";
    render();
  }
  await roomTransport.claimTeam({ teamId, participantToken });
  selectedTeamId = teamId;
  claimAuthenticated = true;
  localStorage.setItem(teamStorageKey(roomId), teamId);
  status = "joined";
  message = connectionMessage();
  if (!restoring && navigator.vibrate) navigator.vibrate(35);
  render();
}

async function releaseTeam() {
  if (connectionState !== "connected") throw new Error("Wait for the relay to reconnect before switching teams.");
  releaseInFlight = true;
  try {
    await roomTransport.releaseTeam({ participantToken });
    selectedTeamId = null;
    claimAuthenticated = false;
    localStorage.removeItem(teamStorageKey(roomId));
    status = "choose";
    message = "Choose your team";
    render();
  } finally {
    releaseInFlight = false;
  }
}

async function placePhoneBid(requestedAmount = null) {
  if (sendingBid || !selectedTeamId) return;
  if (connectionState !== "connected") throw new Error("The relay is reconnecting. Wait for the green status light.");
  if (!hostConnected) throw new Error("The commissioner is offline; bids are paused.");
  const team = room?.teams?.find((item) => item.id === selectedTeamId);
  const nextBid = Number(room?.auction?.nextBid);
  const amount = requestedAmount == null ? nextBid : Number(requestedAmount);
  if (!Number.isInteger(amount)) throw new Error("Enter a whole-dollar bid.");
  if (amount < nextBid) throw new Error(`Your bid must be at least $${nextBid}.`);
  if (amount > Number(team?.maxBid)) throw new Error(`Your team can bid at most $${Number(team?.maxBid || 0)}.`);
  sendingBid = true;
  render();
  try {
    await roomTransport.submitBid({ teamId: selectedTeamId, participantToken, amount });
    message = `Bid $${amount} received by relay`;
    if (navigator.vibrate) navigator.vibrate([45, 35, 45]);
  } catch (error) {
    message = error.message;
    if (navigator.vibrate) navigator.vibrate(120);
    throw error;
  } finally {
    window.setTimeout(() => {
      sendingBid = false;
      render();
    }, 260);
  }
}

function render() {
  if (status === "loading") return renderLoading();
  if (status === "error") return renderError();
  if (!room) return renderLoading();
  if (!selectedTeamId || !claimAuthenticated) return renderTeamChoice();
  renderBidder();
}

function renderShell(content, className = "") {
  app.innerHTML = `<main class="bidder-shell ${className}">
    <header><span class="phone-sun">${sunLogo()}</span><span><strong>Sun God</strong><small>AUCTION SYSTEMS</small></span><i class="connection-dot ${connectionState === "connected" ? "is-live" : ""}"></i></header>
    ${content}
  </main>`;
}

function renderLoading() {
  renderShell(`<section class="join-screen"><span class="loader"></span><span class="kicker">ROOM ${escapeHtml(roomId)}</span><h1>Connecting…</h1><p>${escapeHtml(message)}</p></section>`, "is-join");
}

function renderError() {
  renderShell(`<section class="join-screen"><span class="kicker">ROOM ${escapeHtml(roomId)}</span><h1>Couldn’t join</h1><p class="error-copy">${escapeHtml(message)}</p><button class="wide-secondary" data-action="retry">Try again</button></section>`, "is-join");
}

function renderTeamChoice() {
  renderShell(`<section class="team-choice">
    <span class="kicker">ROOM ${escapeHtml(roomId)}</span><h1>Who are you?</h1><p>Choose your team. One phone can control each team.</p>
    <div class="phone-team-list">${room.teams.map((team) => `<button data-action="claim" data-team-id="${escapeHtml(team.id)}" ${team.claimed || team.autoDraft || connectionState !== "connected" ? "disabled" : ""}><i style="background:${team.color}"></i><span><strong>${escapeHtml(team.manager)}</strong><small>${escapeHtml(team.name)}</small></span><b>${team.autoDraft ? "AUTO" : team.claimed ? "JOINED" : "SELECT"}</b></button>`).join("")}</div>
  </section>`);
}

function renderBidder() {
  const team = room.teams.find((item) => item.id === selectedTeamId);
  if (!team) {
    selectedTeamId = null;
    claimAuthenticated = false;
    return renderTeamChoice();
  }
  const auction = room.auction || {};
  const player = auction.player;
  const hasHighBid = auction.highBidderId === team.id;
  const canAfford = Number(team.maxBid) >= Number(auction.nextBid);
  const hasRosterFit = team.eligibleForPlayer !== false;
  const relayReady = connectionState === "connected" && hostConnected;
  const canBid = relayReady && auction.acceptingBids && !hasHighBid && canAfford && hasRosterFit && !sendingBid;
  const easyBids = easyBidAmounts({
    currentBid: auction.amount,
    nextBid: auction.nextBid,
    suggestedValue: player?.suggestedValue,
    maxBid: team.maxBid
  });
  const buttonLabel = sendingBid
    ? "SENDING…"
    : connectionState !== "connected"
      ? "RECONNECTING…"
      : !hostConnected
        ? "COMMISSIONER OFFLINE"
        : hasHighBid
          ? "YOU HAVE THE BID"
          : !auction.acceptingBids
            ? "WAITING FOR AUCTION"
            : !canAfford
              ? "MAX BID REACHED"
              : !hasRosterFit
                ? "POSITION SLOTS RESERVED"
                : `BID $${auction.nextBid}`;
  const roster = Array.isArray(team.roster) ? team.roster : [];
  const auctionTab = `<div class="phone-lot ${player ? "" : "is-empty"}">
      <span class="kicker">${player ? `${escapeHtml(player.position)} · ${escapeHtml(player.nflTeam)}` : "AUCTION ROOM"}</span>
      <h1>${player ? escapeHtml(player.name) : "Waiting for a player"}</h1>
      <div class="phone-price"><small>${hasHighBid ? "YOUR HIGH BID" : "CURRENT BID"}</small><strong><sup>$</sup>${Number(auction.amount || 0)}</strong></div>
      <span class="phone-phase">${escapeHtml(phaseLabel(auction.phase))}</span>
    </div>
    <button class="bid-button ${hasHighBid ? "is-winning" : ""}" data-action="bid" ${canBid ? "" : "disabled"}>${buttonLabel}<small>${canBid ? "Tap once — every bid is confirmed by the host" : escapeHtml(message)}</small></button>
    <section class="phone-bid-tools" aria-label="Jump bid options">
      <div class="phone-bid-tools-head"><span><small>EASY BIDS</small><strong>Jump the price</strong></span>${player?.suggestedValue ? `<b>SUGGESTED $${Number(player.suggestedValue)}</b>` : ""}</div>
      ${easyBids.length ? `<div class="easy-bid-grid">${easyBids.map((amount) => `<button data-action="bid" data-amount="${amount}" ${canBid ? "" : "disabled"}><small>EASY BID</small><strong>$${amount}</strong></button>`).join("")}</div>` : `<p class="no-easy-bids">No useful round-number jumps remain below the suggested value.</p>`}
      <form id="custom-bid-form" class="custom-bid-form">
        <label><span>$</span><input name="amount" type="number" inputmode="numeric" min="${Number(auction.nextBid || 1)}" max="${Number(team.maxBid || 0)}" step="1" placeholder="${Number(auction.nextBid || 1)}" aria-label="Custom bid amount" ${canBid ? "" : "disabled"} required /></label>
        <button ${canBid ? "" : "disabled"}>Place custom bid</button>
      </form>
    </section>
    <div class="phone-budget"><span><small>BUDGET</small><strong>$${Number(team.budget || 0)}</strong></span><span><small>MAX BID</small><strong>$${Number(team.maxBid || 0)}</strong></span><span><small>ROSTER</small><strong>${Number(team.rosterCount || 0)}/${Number(team.rosterSize || 0)}</strong></span></div>`;
  const rosterTab = `<div class="phone-roster-view">
      <div class="phone-roster-title"><span class="kicker">TEAM BUILDER</span><h1>Your roster</h1><p>${roster.length ? `${roster.length} player${roster.length === 1 ? "" : "s"} drafted` : "Players appear here immediately after they are sold to you."}</p></div>
      <div class="phone-budget"><span><small>REMAINING</small><strong>$${Number(team.budget || 0)}</strong></span><span><small>MAX BID</small><strong>$${Number(team.maxBid || 0)}</strong></span><span><small>PLAYERS</small><strong>${Number(team.rosterCount || 0)}/${Number(team.rosterSize || 0)}</strong></span></div>
      <div class="phone-roster-list">${roster.length ? roster.map((rosterPlayer, index) => `<div class="phone-roster-row"><span class="roster-index">${String(index + 1).padStart(2, "0")}</span><span class="roster-position">${escapeHtml(rosterPlayer.position)}</span><span class="roster-player"><strong>${escapeHtml(rosterPlayer.name)}</strong><small>${escapeHtml(rosterPlayer.nflTeam)}</small></span><b>$${Number(rosterPlayer.price || 0)}</b></div>`).join("") : `<div class="phone-roster-empty"><strong>No players yet</strong><span>Your purchases will sync from the auction laptop.</span></div>`}</div>
    </div>`;
  renderShell(`<section class="bidder-room" style="--team:${team.color}">
    <div class="phone-team-header"><span><small>YOUR TEAM</small><strong>${escapeHtml(team.manager)}</strong><b>${escapeHtml(team.name)}</b></span><button data-action="switch-team">Switch</button></div>
    <nav class="phone-tabs" aria-label="Bidder views"><button class="${activePhoneTab === "auction" ? "is-active" : ""}" data-action="show-tab" data-tab="auction">Auction</button><button class="${activePhoneTab === "roster" ? "is-active" : ""}" data-action="show-tab" data-tab="roster">Roster <b>${roster.length}</b></button></nav>
    ${room.meetingLink ? `<a class="league-call-link" href="${escapeHtml(room.meetingLink)}" target="_blank" rel="noreferrer">Join league call</a>` : ""}
    ${activePhoneTab === "roster" ? rosterTab : auctionTab}
  </section>`);
}

function connectionMessage() {
  if (connectionState !== "connected") return "Reconnecting…";
  if (!hostConnected) return "Commissioner offline — bids are paused.";
  return "Connected";
}

function showMessage(nextMessage, kind = "") {
  message = nextMessage;
  render();
  if (kind === "error" && navigator.vibrate) navigator.vibrate(100);
}

function teamStorageKey(id) { return `sun-god-room-${id}-team`; }
function createToken() { return globalThis.crypto?.randomUUID?.().replaceAll("-", "_") || `phone_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
function phaseLabel(phase) { return ({ idle: "Room ready", ready: "Player nominated", open: "Bidding live", once: "Going once", twice: "Going twice", paused: "Auction paused", sold: "Sold", passed: "No sale" })[phase] || "Room ready"; }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function sunLogo() { return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="16" fill="#d39a20" stroke="currentColor" stroke-width="3"/><circle cx="26" cy="29" r="2" fill="currentColor"/><circle cx="38" cy="29" r="2" fill="currentColor"/><path d="M24 38c5 4 11 4 16 0M32 3v8M32 53v8M3 32h8M53 32h8M11.5 11.5l5.7 5.7M46.8 46.8l5.7 5.7M52.5 11.5l-5.7 5.7M17.2 46.8l-5.7 5.7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`; }
