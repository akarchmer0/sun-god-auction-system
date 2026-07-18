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
let eventSource = null;

localStorage.setItem(TOKEN_KEY, participantToken);
render();
wireEvents();
if (roomId) void loadRoom();
else { status = "code"; message = "Enter the room code shown on the auction laptop."; render(); }

function wireEvents() {
  app.addEventListener("submit", (event) => {
    if (event.target.id !== "room-code-form") return;
    event.preventDefault();
    const nextCode = String(new FormData(event.target).get("room") || "").trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(nextCode)) return showMessage("Enter the six-character room code.", "error");
    roomId = nextCode;
    selectedTeamId = localStorage.getItem(teamStorageKey(roomId));
    window.history.replaceState({}, "", `${window.location.pathname}?room=${encodeURIComponent(roomId)}`);
    void loadRoom();
  });

  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    try {
      if (button.dataset.action === "claim") return await claimTeam(button.dataset.teamId);
      if (button.dataset.action === "bid") return await placePhoneBid();
      if (button.dataset.action === "switch-team") return await releaseTeam();
      if (button.dataset.action === "retry") return await loadRoom();
      if (button.dataset.action === "change-code") {
        selectedTeamId = null;
        roomId = "";
        room = null;
        eventSource?.close();
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
    room = await requestJson(`/api/phone-room?room=${encodeURIComponent(roomId)}`);
    if (selectedTeamId) {
      try { room = await postJson("/api/phone-room/claim", { roomId, teamId: selectedTeamId, participantToken }); }
      catch { selectedTeamId = null; localStorage.removeItem(teamStorageKey(roomId)); }
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
  room = await postJson("/api/phone-room/claim", { roomId, teamId, participantToken });
  selectedTeamId = teamId;
  localStorage.setItem(teamStorageKey(roomId), teamId);
  status = "joined";
  message = "Connected";
  connectToRoomEvents();
  if (navigator.vibrate) navigator.vibrate(35);
  render();
}

async function releaseTeam() {
  await postJson("/api/phone-room/release", { roomId, participantToken });
  selectedTeamId = null;
  localStorage.removeItem(teamStorageKey(roomId));
  status = "choose";
  message = "Choose your team";
  await refreshRoom();
}

async function placePhoneBid() {
  if (sendingBid || !selectedTeamId) return;
  sendingBid = true;
  render();
  try {
    await postJson("/api/phone-room/bid", { roomId, teamId: selectedTeamId, participantToken });
    message = "Bid sent";
    if (navigator.vibrate) navigator.vibrate([45, 35, 45]);
  } catch (error) {
    message = error.message;
    if (navigator.vibrate) navigator.vibrate(120);
  } finally {
    window.setTimeout(() => { sendingBid = false; render(); }, 260);
  }
}

function connectToRoomEvents() {
  eventSource?.close();
  eventSource = new EventSource(`/api/phone-room/events?room=${encodeURIComponent(roomId)}`);
  for (const eventName of ["snapshot", "room", "state"]) {
    eventSource.addEventListener(eventName, (event) => {
      const payload = JSON.parse(event.data);
      room = payload.room;
      if (selectedTeamId && !room.teams.some((team) => team.id === selectedTeamId && team.claimed)) {
        localStorage.removeItem(teamStorageKey(roomId));
        selectedTeamId = null;
        message = "The host reset the connected phones. Choose your team again.";
      }
      status = selectedTeamId ? "joined" : "choose";
      if (selectedTeamId) message = "Connected";
      render();
    });
  }
  eventSource.onopen = () => { message = "Connected"; render(); };
  eventSource.onerror = () => { message = "Reconnecting…"; render(); };
}

async function refreshRoom() {
  room = await requestJson(`/api/phone-room?room=${encodeURIComponent(roomId)}`);
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
    <div class="phone-team-list">${room.teams.map((team) => `<button data-action="claim" data-team-id="${escapeHtml(team.id)}" ${team.claimed ? "disabled" : ""}><i style="background:${team.color}"></i><span><strong>${escapeHtml(team.manager)}</strong><small>${escapeHtml(team.name)}</small></span><b>${team.claimed ? "JOINED" : "SELECT"}</b></button>`).join("")}</div>
    <button class="link-button" data-action="change-code">Use another room code</button>
  </section>`);
}

function renderBidder() {
  const team = room.teams.find((item) => item.id === selectedTeamId);
  if (!team) { selectedTeamId = null; return renderTeamChoice(); }
  const auction = room.auction || {};
  const player = auction.player;
  const hasHighBid = auction.highBidderId === team.id;
  const canAfford = Number(team.maxBid) >= Number(auction.nextBid);
  const canBid = auction.acceptingBids && !hasHighBid && canAfford && !sendingBid;
  const buttonLabel = sendingBid
    ? "SENDING…"
    : hasHighBid
      ? "YOU HAVE THE BID"
      : !auction.acceptingBids
        ? "WAITING FOR AUCTION"
        : !canAfford
          ? "MAX BID REACHED"
          : `BID $${auction.nextBid}`;
  renderShell(`<section class="bidder-room" style="--team:${team.color}">
    <div class="phone-team-header"><span><small>YOUR TEAM</small><strong>${escapeHtml(team.manager)}</strong><b>${escapeHtml(team.name)}</b></span><button data-action="switch-team">Switch</button></div>
    <div class="phone-lot ${player ? "" : "is-empty"}">
      <span class="kicker">${player ? `${escapeHtml(player.position)} · ${escapeHtml(player.nflTeam)}` : "AUCTION ROOM"}</span>
      <h1>${player ? escapeHtml(player.name) : "Waiting for a player"}</h1>
      <div class="phone-price"><small>${hasHighBid ? "YOUR HIGH BID" : "CURRENT BID"}</small><strong><sup>$</sup>${Number(auction.amount || 0)}</strong></div>
      <span class="phone-phase">${escapeHtml(phaseLabel(auction.phase))}</span>
    </div>
    <button class="bid-button ${hasHighBid ? "is-winning" : ""}" data-action="bid" ${canBid ? "" : "disabled"}>${buttonLabel}<small>${canBid ? "Tap once — every bid is confirmed by the host" : escapeHtml(message)}</small></button>
    <div class="phone-budget"><span><small>BUDGET</small><strong>$${Number(team.budget || 0)}</strong></span><span><small>MAX BID</small><strong>$${Number(team.maxBid || 0)}</strong></span><span><small>ROSTER</small><strong>${Number(team.rosterCount || 0)}/${Number(team.rosterSize || 0)}</strong></span></div>
  </section>`);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The draft room is unavailable.");
  return payload;
}

function postJson(url, body) {
  return requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
