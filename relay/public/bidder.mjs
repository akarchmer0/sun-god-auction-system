import { easyBidAmounts } from "./phone-bidding.mjs";
import { RemotePhoneAudio } from "./phone-audio.mjs";
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
let viewedRosterTeamId = selectedTeamId;
let rosterPickerOpen = false;
let customBidAmount = null;
let customBidLotKey = null;
let customBidDragging = false;
let phoneCountdownTimer = null;
const phoneAudio = new RemotePhoneAudio({ onStateChange: () => render() });

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
      if (button.dataset.action === "toggle-sound") { await phoneAudio.toggle(); render(); return; }
      if (phoneAudio.enabled && phoneAudio.state !== "on") void phoneAudio.unlock();
      if (button.dataset.action === "claim") return await claimTeam(button.dataset.teamId);
      if (button.dataset.action === "bid") return await placePhoneBid(button.dataset.amount == null ? null : Number(button.dataset.amount));
      if (button.dataset.action === "show-tab") {
        activePhoneTab = ["roster", "history"].includes(button.dataset.tab) ? button.dataset.tab : "auction";
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
      if (button.dataset.action === "retry") return connectToRelay();
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  app.addEventListener("input", (event) => {
    if (!event.target.matches('#custom-bid-form input[name="amount"]')) return;
    customBidAmount = Number(event.target.value);
    updateCustomBidTuner(event.target);
  });
  app.addEventListener("pointerdown", (event) => {
    if (event.target.matches('#custom-bid-form input[name="amount"]')) customBidDragging = true;
  });
  window.addEventListener("pointerup", () => { customBidDragging = false; });
  window.addEventListener("pointercancel", () => { customBidDragging = false; });
  document.addEventListener("visibilitychange", () => phoneAudio.handleVisibilityChange(document.hidden));
}

function connectToRelay() {
  roomTransport?.close();
  phoneAudio.cancel();
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
    },
    (audio) => {
      if (roomTransport === transport) phoneAudio.handleAudio(audio);
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
    phoneAudio.cancel();
    if (!room) status = "loading";
    message = nextState === "connecting" ? "Connecting to the draft room…" : "Reconnecting…";
  }
  render();
}

function handleRelayMessage(payload) {
  if (String(payload.type || "").startsWith("speech.")) {
    phoneAudio.handleControl(payload);
    return;
  }
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
      viewedRosterTeamId = null;
      rosterPickerOpen = false;
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
    if (!hostConnected) phoneAudio.cancel();
    message = connectionMessage();
    render();
    return;
  }
  if (payload.type === "room.close") {
    phoneAudio.cancel();
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
    viewedRosterTeamId = null;
    rosterPickerOpen = false;
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
  viewedRosterTeamId = teamId;
  rosterPickerOpen = false;
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
    viewedRosterTeamId = null;
    rosterPickerOpen = false;
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
  const bidMode = requestedAmount == null ? "next" : "custom";
  const amount = requestedAmount == null ? nextBid : Number(requestedAmount);
  if (!Number.isInteger(amount)) throw new Error("Enter a whole-dollar bid.");
  if (amount < nextBid) throw new Error(`Your bid must be at least $${nextBid}.`);
  if (amount > Number(team?.maxBid)) throw new Error(`Your team can bid at most $${Number(team?.maxBid || 0)}.`);
  sendingBid = true;
  render();
  try {
    let receipt;
    try {
      receipt = await roomTransport.submitBid({ teamId: selectedTeamId, participantToken, amount, bidMode });
    } catch (error) {
      if (!/claim a team before bidding/i.test(String(error?.message || ""))) throw error;
      await roomTransport.claimTeam({ teamId: selectedTeamId, participantToken });
      claimAuthenticated = true;
      receipt = await roomTransport.submitBid({ teamId: selectedTeamId, participantToken, amount, bidMode });
    }
    message = `Bid $${Number(receipt?.amount || amount)} received by relay`;
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
  clearPhoneCountdown();
  if (status === "loading") return renderLoading();
  if (status === "error") return renderError();
  if (!room) return renderLoading();
  if (!selectedTeamId || !claimAuthenticated) return renderTeamChoice();
  renderBidder();
}

function clearPhoneCountdown() {
  if (phoneCountdownTimer) window.clearInterval(phoneCountdownTimer);
  phoneCountdownTimer = null;
}

function startPhoneCountdown(auction) {
  const countdownValue = app.querySelector("[data-phone-countdown-value]");
  const countdownEndsAt = Number(auction?.countdownEndsAt);
  if (!countdownValue || !Number.isFinite(countdownEndsAt) || countdownEndsAt <= 0) return;
  const updateCountdown = () => {
    const secondsRemaining = Math.max(0, countdownEndsAt - Date.now()) / 1_000;
    countdownValue.textContent = secondsRemaining.toFixed(1);
  };
  updateCountdown();
  phoneCountdownTimer = window.setInterval(updateCountdown, 100);
}

function renderShell(content, className = "") {
  renderAppHtml(`<main class="bidder-shell ${className}">
    <header><span class="phone-sun">${sunLogo()}</span><span><strong>Sun God</strong><small>AUCTION SYSTEMS</small></span>${soundToggle()}<i class="connection-dot ${connectionState === "connected" ? "is-live" : ""}"></i></header>
    <div class="phone-audio-feedback ${phoneAudio.state === "unsupported" || phoneAudio.statusText.startsWith("Phone voice error") ? "is-error" : ""}" role="status" aria-live="polite">${escapeHtml(phoneAudio.statusText)}</div>
    ${content}
  </main>`);
}

function renderAppHtml(html) {
  const customBidInput = app.querySelector('#custom-bid-form input[name="amount"]');
  const preserveCustomBid = customBidInput && (customBidDragging || document.activeElement === customBidInput);
  if (!preserveCustomBid) {
    app.innerHTML = html;
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  if (!template.content.querySelector('#custom-bid-form input[name="amount"]')) {
    app.innerHTML = html;
    return;
  }
  // Reconcile live auction updates without detaching a tuner that is being dragged.
  patchDomChildren(app, template.content);
}

function updateCustomBidTuner(input) {
  const form = input.closest("#custom-bid-form");
  const amount = Number(input.value);
  const minimum = Number(input.min);
  const maximum = Number(input.max);
  const progress = maximum > minimum ? ((amount - minimum) / (maximum - minimum)) * 100 : 100;
  input.style.setProperty("--bid-progress", `${progress}%`);
  input.setAttribute("aria-valuetext", `$${amount}`);
  const output = form?.querySelector("output");
  const button = form?.querySelector("button");
  if (output) output.textContent = `$${amount}`;
  if (button) button.textContent = `Place $${amount} bid`;
}

function patchDomChildren(currentParent, nextParent) {
  const nextChildren = [...nextParent.childNodes];
  let index = 0;
  while (index < nextChildren.length) {
    const currentChild = currentParent.childNodes[index];
    const nextChild = nextChildren[index];
    if (!currentChild) {
      currentParent.append(nextChild.cloneNode(true));
      index += 1;
      continue;
    }
    if (sameDomKind(currentChild, nextChild)) {
      patchDomNode(currentChild, nextChild);
      index += 1;
      continue;
    }

    const laterNextMatch = nextChildren.slice(index + 1).findIndex((candidate) => sameDomKind(currentChild, candidate));
    if (laterNextMatch >= 0) {
      currentParent.insertBefore(nextChild.cloneNode(true), currentChild);
      index += 1;
      continue;
    }
    const laterCurrentMatch = [...currentParent.childNodes].slice(index + 1).findIndex((candidate) => sameDomKind(candidate, nextChild));
    if (laterCurrentMatch >= 0) {
      currentChild.remove();
      continue;
    }
    currentChild.replaceWith(nextChild.cloneNode(true));
    index += 1;
  }
  while (currentParent.childNodes.length > nextChildren.length) currentParent.lastChild.remove();
}

function patchDomNode(currentNode, nextNode) {
  if (currentNode.nodeType !== 1) {
    if (currentNode.nodeValue !== nextNode.nodeValue) currentNode.nodeValue = nextNode.nodeValue;
    return;
  }
  for (const attribute of [...currentNode.attributes]) {
    if (!nextNode.hasAttribute(attribute.name)) currentNode.removeAttribute(attribute.name);
  }
  for (const attribute of [...nextNode.attributes]) {
    if (currentNode.getAttribute(attribute.name) !== attribute.value) currentNode.setAttribute(attribute.name, attribute.value);
  }
  patchDomChildren(currentNode, nextNode);
}

function sameDomKind(left, right) {
  if (left.nodeType !== right.nodeType) return false;
  if (left.nodeType !== 1) return true;
  if (left.tagName !== right.tagName) return false;
  const leftId = left.getAttribute("id");
  const rightId = right.getAttribute("id");
  return !leftId && !rightId || leftId === rightId;
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
    viewedRosterTeamId = null;
    rosterPickerOpen = false;
    claimAuthenticated = false;
    return renderTeamChoice();
  }
  const auction = room.auction || {};
  const player = auction.player;
  const highBidder = room.teams.find((item) => item.id === auction.highBidderId);
  const hasHighBid = auction.highBidderId === team.id;
  const hasAnyBid = Boolean(highBidder);
  const canAfford = Number(team.maxBid) >= Number(auction.nextBid);
  const hasRosterFit = team.eligibleForPlayer !== false;
  const relayReady = connectionState === "connected" && hostConnected;
  const canBid = relayReady && auction.acceptingBids && !hasHighBid && canAfford && hasRosterFit && !sendingBid;
  const customBidMinimum = Number(auction.nextBid || 1);
  const customBidMaximum = Math.max(customBidMinimum, Number(team.maxBid || 0));
  const nextCustomBidLotKey = `${player?.id || "waiting"}:${selectedTeamId}`;
  if (customBidLotKey !== nextCustomBidLotKey) {
    customBidLotKey = nextCustomBidLotKey;
    customBidAmount = customBidMinimum;
  }
  customBidAmount = Math.min(customBidMaximum, Math.max(customBidMinimum, Number(customBidAmount) || customBidMinimum));
  const customBidProgress = customBidMaximum > customBidMinimum
    ? ((customBidAmount - customBidMinimum) / (customBidMaximum - customBidMinimum)) * 100
    : 100;
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
  const rosterTeam = room.teams.find((item) => item.id === viewedRosterTeamId) || team;
  viewedRosterTeamId = rosterTeam.id;
  const roster = Array.isArray(rosterTeam.roster) ? rosterTeam.roster : [];
  const history = Array.isArray(room.history) ? room.history : [];
  const showCountdown = ["once", "twice"].includes(auction.phase);
  const auctionTab = `<div class="phone-lot ${player ? "" : "is-empty"}">
      ${showCountdown ? `<div class="phone-countdown" role="timer" aria-label="${escapeHtml(phaseLabel(auction.phase))} countdown"><span>TIME LEFT</span><strong data-phone-countdown-value>—</strong><small>SECONDS</small></div>` : ""}
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
        <div class="custom-bid-tuner">
          <div><span>DRAG TO SET BID</span><output name="custom-bid-output">$${customBidAmount}</output></div>
          <input name="amount" type="range" min="${customBidMinimum}" max="${customBidMaximum}" value="${customBidAmount}" step="1" aria-label="Custom bid amount" aria-valuetext="$${customBidAmount}" style="--bid-progress:${customBidProgress}%" ${canBid ? "" : "disabled"} />
          <small><span>$${customBidMinimum} MIN</span><span>$${customBidMaximum} MAX</span></small>
        </div>
        <button ${canBid ? "" : "disabled"}>Place $${customBidAmount} bid</button>
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
  const historyTab = `<div class="phone-history-view">
      <div class="phone-history-title"><span class="kicker">DRAFT LEDGER</span><h1>Auction history</h1><p>${history.length ? `${history.length} completed auction${history.length === 1 ? "" : "s"} · Most recent first` : "Completed auctions will appear here."}</p></div>
      <div class="phone-history-list">${history.length ? [...history].reverse().map((sale) => `<article class="phone-history-row"><span class="history-lot">${String(Number(sale.lotNumber || 0)).padStart(2, "0")}</span><span class="history-player"><small>${escapeHtml(sale.position)} · ${escapeHtml(sale.nflTeam)}</small><strong>${escapeHtml(sale.playerName)}</strong></span><b>$${Number(sale.amount || 0)}</b><span class="history-winner" style="--history-team:${sale.teamColor}"><i></i><span><small>WINNING TEAM</small><strong>${escapeHtml(sale.teamName)}</strong><em>${escapeHtml(sale.manager)}</em></span></span></article>`).join("") : `<div class="phone-history-empty"><strong>No completed auctions yet</strong><span>Winning players, prices, and teams will appear here after each sale.</span></div>`}</div>
    </div>`;
  renderShell(`<section class="bidder-room ${activePhoneTab === "history" ? "is-history" : ""}" style="--team:${team.color}">
    <div class="phone-team-header"><span><small>YOUR TEAM</small><strong>${escapeHtml(team.manager)}</strong><b>${escapeHtml(team.name)}</b></span><button data-action="switch-team">Switch</button></div>
    <nav class="phone-tabs has-history" aria-label="Bidder views"><button class="${activePhoneTab === "auction" ? "is-active" : ""}" data-action="show-tab" data-tab="auction">Auction</button><button class="${activePhoneTab === "roster" ? "is-active" : ""}" data-action="show-tab" data-tab="roster">Roster <b>${roster.length}</b></button><button class="${activePhoneTab === "history" ? "is-active" : ""}" data-action="show-tab" data-tab="history">History <b>${history.length}</b></button></nav>
    ${room.meetingLink ? `<a class="league-call-link" href="${escapeHtml(room.meetingLink)}" target="_blank" rel="noreferrer">Join league call</a>` : ""}
    ${activePhoneTab === "roster" ? rosterTab : activePhoneTab === "history" ? historyTab : auctionTab}
  </section>`);
  if (activePhoneTab === "auction") startPhoneCountdown(auction);
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
function soundToggle() {
  const state = phoneAudio.state;
  const label = state === "unsupported" ? "Browser voice unavailable" : state === "muted" ? "Turn on auctioneer sound" : state === "on" ? "Mute auctioneer sound" : "Tap to enable auctioneer sound";
  return `<button class="phone-sound-toggle ${state === "on" ? "is-on" : state === "needs-gesture" ? "needs-gesture" : ""}" data-action="toggle-sound" aria-label="${label}" aria-pressed="${state !== "muted"}" title="${label}">${soundIcon(state === "muted")}</button>`;
}
function phaseLabel(phase) { return ({ idle: "Room ready", ready: "Player nominated", open: "Bidding live", once: "Going once", twice: "Going twice", paused: "Auction paused", sold: "Sold", passed: "No sale" })[phase] || "Room ready"; }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function sunLogo() { return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="16" fill="#d39a20" stroke="currentColor" stroke-width="3"/><circle cx="26" cy="29" r="2" fill="currentColor"/><circle cx="38" cy="29" r="2" fill="currentColor"/><path d="M24 38c5 4 11 4 16 0M32 3v8M32 53v8M3 32h8M53 32h8M11.5 11.5l5.7 5.7M46.8 46.8l5.7 5.7M52.5 11.5l-5.7 5.7M17.2 46.8l-5.7 5.7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`; }
function soundIcon(muted) { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4Z" fill="currentColor"/><path d="M16 9c1.4 1.6 1.4 4.4 0 6M18.5 6.5c3 3 3 8 0 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>${muted ? `<path d="m15 8 6 8M21 8l-6 8" fill="none" stroke="#9d3c28" stroke-width="2" stroke-linecap="round"/>` : ""}</svg>`; }
