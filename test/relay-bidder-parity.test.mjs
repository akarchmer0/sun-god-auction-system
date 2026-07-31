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

test("remote bidder exposes the local auction, easy-bid, custom-bid, and roster views", async () => {
  const [html, client] = await Promise.all([
    source("relay/public/index.html"),
    source("relay/public/bidder.mjs")
  ]);

  assert.match(html, /id="bidder-app"/);
  assert.match(html, /family=DM\+Mono/);
  assert.match(client, /easyBidAmounts/);
  assert.match(client, /RelayRoomTransport/);
  assert.match(client, /class="easy-bid-grid"/);
  assert.match(client, /id="custom-bid-form"/);
  assert.match(client, /class="phone-roster-list"/);
  assert.match(client, /data-tab="roster"/);
  assert.match(client, /class="league-call-link"/);
});

function source(pathname) {
  return readFile(new URL(pathname, projectRoot), "utf8");
}
