import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);

test("remote bidder ships the same visual system and shared bidding modules as local", async () => {
  const [localCss, remoteCss, localBids, remoteBids, localProtocol, remoteProtocol, localTransports, remoteTransports] = await Promise.all([
    source("src/bidder.css"),
    source("relay/public/bidder.css"),
    source("src/phone-bidding.mjs"),
    source("relay/public/phone-bidding.mjs"),
    source("src/room-protocol.mjs"),
    source("relay/public/room-protocol.mjs"),
    source("src/room-transports.mjs"),
    source("relay/public/room-transports.mjs")
  ]);

  assert.equal(remoteCss, localCss);
  assert.equal(remoteBids, localBids);
  assert.equal(remoteProtocol, localProtocol);
  assert.equal(remoteTransports, localTransports);
});

test("remote bidder exposes auction, roster, and completed-auction history views", async () => {
  const [html, client, localClient, hostClient] = await Promise.all([
    source("relay/public/index.html"),
    source("relay/public/bidder.mjs"),
    source("src/bidder.mjs"),
    source("src/app.mjs")
  ]);

  assert.match(html, /id="bidder-app"/);
  assert.match(html, /family=DM\+Mono/);
  assert.match(client, /easyBidAmounts/);
  assert.match(client, /RelayRoomTransport/);
  assert.match(client, /bidMode = requestedAmount == null \? "next" : "custom"/);
  assert.match(client, /claim a team before bidding/);
  assert.match(client, /await roomTransport\.claimTeam\(\{ teamId: selectedTeamId, participantToken \}\)/);
  assert.match(client, /RemotePhoneAudio/);
  assert.match(client, /data-action="toggle-sound"/);
  assert.match(client, /class="easy-bid-grid"/);
  assert.match(client, /id="custom-bid-form"/);
  assert.match(client, /class="phone-roster-list"/);
  assert.match(client, /data-tab="roster"/);
  assert.match(client, /data-tab="history"/);
  assert.match(client, /class="phone-history-list"/);
  assert.match(client, /class="history-winner"/);
  assert.match(client, /class="league-call-link"/);
  assert.doesNotMatch(localClient, /data-tab="history"/);
  assert.match(hostClient, /history: buildPhoneAuctionHistory\(state\)/);
  assert.match(hostClient, /countdownEndsAt:/);
  assert.match(hostClient, /bid\.bidMode === "next" \? nextVisualBidAmount\(state\)/);
  for (const bidderClient of [localClient, client]) {
    assert.match(bidderClient, /class="phone-bid-holder"/);
    assert.match(bidderClient, /HELD BY/);
    assert.match(bidderClient, /highBidder\.name/);
    assert.match(bidderClient, /type="range"/);
    assert.match(bidderClient, /customBidLotKey/);
    assert.match(bidderClient, /customBidDragging/);
    assert.match(bidderClient, /data-phone-countdown-value/);
    assert.match(bidderClient, /startPhoneCountdown\(auction\)/);
    assert.match(bidderClient, /Math\.max\(customBidMinimum/);
    assert.doesNotMatch(bidderClient, /inputmode="numeric"/);
    assert.match(bidderClient, /data-action="toggle-roster-picker"/);
    assert.match(bidderClient, /data-action="view-roster"/);
    assert.match(bidderClient, /const rosterTeam = room\.teams\.find/);
  }
});

function source(pathname) {
  return readFile(new URL(pathname, projectRoot), "utf8");
}
