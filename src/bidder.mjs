import { easyBidAmounts } from "./phone-bidding.mjs";
import { LanRoomTransport } from "./room-transports.mjs";

const app = document.querySelector("#bidder-app");
const params = new URL(window.location.href).searchParams;
const TOKEN_KEY = "sun-god-bidder-token";
let roomId = String(params.get("room") || "").trim().toUpperCase();
let participantToken = localStorage.getItem(TOKEN_KEY) || createToken();
let selectedTeamId = roomId ? localStorage.getItem(teamStorageKey(roomId)) : null;
let room = null;
let status = "loading";
let message = "Connecting to the draft room…";
let sendingBid = false;
let roomTransport = roomId ? new LanRoomTransport({ roomId }) : null;
let activePhoneTab = "auction";
let viewedRosterTeamId = selectedTeamId;
let rosterPickerOpen = false;

localStorage.setItem(TOKEN_KEY, participantToken);
render();
wireEvents();
if (roomId) void loadRoom();
else { status = "code"; message = "Enter the room code shown on the auction laptop."; render(); }

function wireEvents() {
  app.addEventListener("submit", async (event) => {
    if (event.target.id === "room-code-form") {
      event.preventDefault();
      const nextCode = String(new FormData(event.target).get("room") || "").trim().toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(nextCode)) return showMessage("Enter the six-character room code.", "error");
      roomId = nextCode;
      roomTransport?.close();
      roomTransport = new LanRoomTransport({ roomId });
      selectedTeamId = localStorage.getItem(teamStorageKey(roomId));
      viewedRosterTeamId = selectedTeamId;
      rosterPickerOpen = false;
      window.history.replaceState({}, "", `${window.location.pathname}?room=${encodeURIComponent(roomId)}`);
      void loadRoom();
      return;
    }
    if (event.target.id === "custom-bid-form") {
      event.preventDefault();
      const amount = Number(new FormData(event.target).get("amount"));
      try { await placePhoneBid(amount); }
      catch (error) { showMessage(error.message, "error"); }
    }
  });

  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    try {
      if (button.dataset.action === "claim") return await claimTeam(button.dataset.teamId);
      if (button.dataset.action === "bid") return await placePhoneBid(button.dataset.amount == null ? null : Number(button.dataset.amount));
      if (button.dataset.action === "show-tab") {
        activePhoneTab = button.dataset.tab === "roster" ? "roster" : "auction";
        if (activePhoneTab === "roster" && !viewedRosterTeamId) viewedRosterTeamId = selectedTeamId;
        if (activePhoneTab !== "roster") rosterPickerOpen = false;
        render();
        return;
      }
      if (button.dataset.action === "toggle-roster-picker") { rosterPickerOpen = !rosterPickerOpen; render(); return; }
      if (button.dataset.action === "view-roster") {
        if (room?.teams?.some((item) => item.id === button.dataset.teamId)) viewedRosterTeamId = button.dataset.teamId;
        rosterPickerOpen = false;
        activePhoneTab = "roster";
        render();
        return;
      }
      if (button.dataset.action === "switch-team") return await releaseTeam();
      if (button.dataset.action === "retry") return await loadRoom();
      if (button.dataset.action === "change-code") {
        selectedTeamId = null;
        viewedRosterTeamId = null;
        rosterPickerOpen = false;
        roomId = "";
        room = null;
        roomTransport?.close();
        roomTransport = null;
        status = "code";
        window.history.replaceState({}, "", window.location.pathname);
        render();
      }
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
}

async function loadRoom() {
  status = "loading";
  message = "Connecting to the draft room…";
  render();
  try {
    roomTransport ||= new LanRoomTransport({ roomId });
    room = await roomTransport.snapshot();
    if (selectedTeamId) {
      try { room = await roomTransport.claimTeam({ roomId, teamId: selectedTeamId, participantToken }); }
      catch { selectedTeamId = null; viewedRosterTeamId = null; localStorage.removeItem(teamStorageKey(roomId)); }
    }
    status = selectedTeamId ? "joined" : "choose";
    message = selectedTeamId ? "Connected" : "Choose your team";
    connectToRoomEvents();
    render();
  } catch (error) {
    status = "error";
    message = error.message;
    render();
  }
}

async function claimTeam(teamId) {
  room = await roomTransport.claimTeam({ roomId, teamId, participantToken });
  selectedTeamId = teamId;
  viewedRosterTeamId = teamId;
  rosterPickerOpen = false;
  localStorage.setItem(teamStorageKey(roomId), teamId);
  status = "joined";
  message = "Connected";
  connectToRoomEvents();
  if (navigator.vibrate) navigator.vibrate(35);
  render();
}

async function releaseTeam() {
  await roomTransport.releaseTeam({ roomId, participantToken });
  selectedTeamId = null;
  viewedRosterTeamId = null;
  rosterPickerOpen = false;
  localStorage.removeItem(teamStorageKey(roomId));
  status = "choose";
  message = "Choose your team";
  await refreshRoom();
}

async function placePhoneBid(requestedAmount = null) {
  if (sendingBid || !selectedTeamId) return;
  const team = room?.teams?.find((item) => item.id === selectedTeamId);
  const nextBid = Number(room?.auction?.nextBid);
  const amount = requestedAmount == null ? nextBid : Number(requestedAmount);
  if (!Number.isInteger(amount)) throw new Error("Enter a whole-dollar bid.");
  if (amount < nextBid) throw new Error(`Your bid must be at least $${nextBid}.`);
  if (amount > Number(team?.maxBid)) throw new Error(`Your team can bid at most $${Number(team?.maxBid || 0)}.`);
  sendingBid = true;
  render();
  try {
    await roomTransport.submitBid({ roomId, teamId: selectedTeamId, participantToken, amount });
    message = `Bid $${amount} sent`;
    if (navigator.vibrate) navigator.vibrate([45, 35, 45]);
  } catch (error) {
    message = error.message;
    if (navigator.vibrate) navigator.vibrate(120);
  } finally {
    window.setTimeout(() => { sendingBid = false; render(); }, 260);
  }
}

function connectToRoomEvents() {
  roomTransport.connect((payload) => {
    if (["snapshot", "room", "state"].includes(payload.type)) {
      room = payload.room;
      if (selectedTeamId && !room.teams.some((team) => team.id === selectedTeamId && team.claimed)) {
        localStorage.removeItem(teamStorageKey(roomId));
        selectedTeamId = null;
        viewedRosterTeamId = null;
        rosterPickerOpen = false;
        message = "The host reset the connected phones. Choose your team again.";
      }
      status = selectedTeamId ? "joined" : "choose";
      if (selectedTeamId) message = "Connected";
      render();
    }
  }, ({ state }) => {
    message = state === "connected" ? "Connected" : "Reconnecting…";
    render();
  });
}

async function refreshRoom() {
  room = await roomTransport.snapshot();
  render();
}

function render() {
  if (status === "code") return renderCodeEntry();
  if (status === "loading") return renderLoading();
  if (status === "error") return renderError();
  if (!selectedTeamId) return renderTeamChoice();
  renderBidder();
}

function renderShell(content, className = "") {
  app.innerHTML = `<main class="bidder-shell ${className}">
    <header><span class="phone-sun">${sunLogo()}</span><span><strong>Sun God</strong><small>AUCTION SYSTEMS</small></span><i class="connection-dot ${message === "Connected" ? "is-live" : ""}"></i></header>
    ${content}
  </main>`;
}

function renderCodeEntry() {
  renderShell(`<section class="join-screen">
    <span class="kicker">JOIN THE DRAFT</span>
    <h1>Enter room code</h1>
    <p>${escapeHtml(message)}</p>
    <form id="room-code-form"><input name="room" maxlength="6" inputmode="text" autocomplete="off" autocapitalize="characters" placeholder="SUN123" aria-label="Room code" /><button>Join room</button></form>
  </section>`, "is-join");
}

function renderLoading() {
  renderShell(`<section class="join-screen"><span class="loader"></span><span class="kicker">ROOM ${escapeHtml(roomId)}</span><h1>Connecting…</h1><p>${escapeHtml(message)}</p></section>`, "is-join");
}

function renderError() {
  renderShell(`<section class="join-screen"><span class="kicker">ROOM ${escapeHtml(roomId)}</span><h1>Couldn’t join</h1><p class="error-copy">${escapeHtml(message)}</p><button class="wide-secondary" data-action="retry">Try again</button><button class="link-button" data-action="change-code">Use another code</button></section>`, "is-join");
}

function renderTeamChoice() {
  renderShell(`<section class="team-choice">
    <span class="kicker">ROOM ${escapeHtml(roomId)}</span><h1>Who are you?</h1><p>Choose your team. One phone can control each team.</p>
    <div class="phone-team-list">${room.teams.map((team) => `<button data-action="claim" data-team-id="${escapeHtml(team.id)}" ${team.claimed || team.autoDraft ? "disabled" : ""}><i style="background:${team.color}"></i><span><strong>${escapeHtml(team.manager)}</strong><small>${escapeHtml(team.name)}</small></span><b>${team.autoDraft ? "AUTO" : team.claimed ? "JOINED" : "SELECT"}</b></button>`).join("")}</div>
    <button class="link-button" data-action="change-code">Use another room code</button>
  </section>`);
}

function renderBidder() {
  const team = room.teams.find((item) => item.id === selectedTeamId);
  if (!team) { selectedTeamId = null; viewedRosterTeamId = null; rosterPickerOpen = false; return renderTeamChoice(); }
  const auction = room.auction || {};
  const player = auction.player;
  const highBidder = room.teams.find((item) => item.id === auction.highBidderId);
  const hasHighBid = auction.highBidderId === team.id;
  const hasAnyBid = Boolean(highBidder);
  const canAfford = Number(team.maxBid) >= Number(auction.nextBid);
  const hasRosterFit = team.eligibleForPlayer !== false;
  const canBid = auction.acceptingBids && !hasHighBid && canAfford && hasRosterFit && !sendingBid;
  const easyBids = easyBidAmounts({
    currentBid: auction.amount,
    nextBid: auction.nextBid,
    suggestedValue: player?.suggestedValue,
    maxBid: team.maxBid
  });
  const buttonLabel = sendingBid
    ? "SENDING…"
    : hasHighBid
      ? "YOU HAVE THE BID"
      : !auction.acceptingBids
        ? "WAITING FOR AUCTION"
        : !canAfford
          ? "MAX BID REACHED"
          : !hasRosterFit
            ? "POSITION SLOTS RESERVED"
          : `BID $${auction.nextBid}`;
  const rosterTeam = room.teams.find((item) => item.id === viewedRosterTeamId) || team;
  viewedRosterTeamId = rosterTeam.id;
  const roster = Array.isArray(rosterTeam.roster) ? rosterTeam.roster : [];
  const auctionTab = `<div class="phone-lot ${player ? "" : "is-empty"}">
      <span class="kicker">${player ? `${escapeHtml(player.position)} · ${escapeHtml(player.nflTeam)}` : "AUCTION ROOM"}</span>
      <h1>${player ? escapeHtml(player.name) : "Waiting for a player"}</h1>
      <div class="phone-price"><small>${hasHighBid ? "YOUR HIGH BID" : hasAnyBid ? "CURRENT BID" : "OPENING BID"}</small><strong><sup>$</sup>${Number(auction.amount || 1)}</strong>${highBidder ? `<div class="phone-bid-holder" style="--bid-holder:${highBidder.color}"><i></i><span><small>HELD BY</small><b>${escapeHtml(highBidder.name)}</b></span><em>${escapeHtml(highBidder.manager)}</em></div>` : ""}</div>
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
  const rosterTab = `<div class="phone-roster-view" style="--roster-team:${rosterTeam.color}">
      <div class="phone-roster-title">
        <button class="phone-roster-picker" data-action="toggle-roster-picker" aria-expanded="${rosterPickerOpen}" aria-haspopup="listbox"><i></i><span><small>VIEWING ROSTER</small><strong>${escapeHtml(rosterTeam.name)}</strong><b>${escapeHtml(rosterTeam.manager)}</b></span><em>${rosterPickerOpen ? "CLOSE" : "CHANGE"}<u aria-hidden="true">⌄</u></em></button>
        ${rosterPickerOpen ? `<div class="phone-roster-menu" role="listbox" aria-label="Choose a team roster">${room.teams.map((rosterOption) => `<button data-action="view-roster" data-team-id="${escapeHtml(rosterOption.id)}" role="option" aria-selected="${rosterOption.id === rosterTeam.id}" class="${rosterOption.id === rosterTeam.id ? "is-selected" : ""}"><i style="background:${rosterOption.color}"></i><span><strong>${escapeHtml(rosterOption.name)}</strong><small>${escapeHtml(rosterOption.manager)}</small></span><b>${Number(rosterOption.rosterCount || 0)}/${Number(rosterOption.rosterSize || 0)}</b></button>`).join("")}</div>` : ""}
        <p>${roster.length ? `${roster.length} player${roster.length === 1 ? "" : "s"} drafted` : "No players drafted yet"} · Tap the header to switch teams.</p>
      </div>
      <div class="phone-budget"><span><small>REMAINING</small><strong>$${Number(rosterTeam.budget || 0)}</strong></span><span><small>MAX BID</small><strong>$${Number(rosterTeam.maxBid || 0)}</strong></span><span><small>PLAYERS</small><strong>${Number(rosterTeam.rosterCount || 0)}/${Number(rosterTeam.rosterSize || 0)}</strong></span></div>
      <div class="phone-roster-list">${roster.length ? roster.map((rosterPlayer, index) => `<div class="phone-roster-row"><span class="roster-index">${String(index + 1).padStart(2, "0")}</span><span class="roster-position">${escapeHtml(rosterPlayer.position)}</span><span class="roster-player"><strong>${escapeHtml(rosterPlayer.name)}</strong><small>${escapeHtml(rosterPlayer.nflTeam)}</small></span><b>$${Number(rosterPlayer.price || 0)}</b></div>`).join("") : `<div class="phone-roster-empty"><strong>No players yet</strong><span>${escapeHtml(rosterTeam.name)}’s purchases will appear here as players are sold.</span></div>`}</div>
    </div>`;
  renderShell(`<section class="bidder-room" style="--team:${team.color}">
    <div class="phone-team-header"><span><small>YOUR TEAM</small><strong>${escapeHtml(team.manager)}</strong><b>${escapeHtml(team.name)}</b></span><button data-action="switch-team">Switch</button></div>
    <nav class="phone-tabs" aria-label="Bidder views"><button class="${activePhoneTab === "auction" ? "is-active" : ""}" data-action="show-tab" data-tab="auction">Auction</button><button class="${activePhoneTab === "roster" ? "is-active" : ""}" data-action="show-tab" data-tab="roster">Roster <b>${roster.length}</b></button></nav>
    ${activePhoneTab === "roster" ? rosterTab : auctionTab}
  </section>`);
}

function showMessage(nextMessage, kind = "") {
  message = nextMessage;
  render();
  if (kind === "error" && navigator.vibrate) navigator.vibrate(100);
}

function teamStorageKey(id) { return `sun-god-room-${id}-team`; }
function createToken() { return crypto.randomUUID?.().replaceAll("-", "_") || `phone_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
function phaseLabel(phase) { return ({ idle: "Room ready", ready: "Player nominated", open: "Bidding live", once: "Going once", twice: "Going twice", paused: "Auction paused", sold: "Sold", passed: "No sale" })[phase] || "Room ready"; }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function sunLogo() { return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="16" fill="#d39a20" stroke="currentColor" stroke-width="3"/><circle cx="26" cy="29" r="2" fill="currentColor"/><circle cx="38" cy="29" r="2" fill="currentColor"/><path d="M24 38c5 4 11 4 16 0M32 3v8M32 53v8M3 32h8M53 32h8M11.5 11.5l5.7 5.7M46.8 46.8l5.7 5.7M52.5 11.5l-5.7 5.7M17.2 46.8l-5.7 5.7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`; }
