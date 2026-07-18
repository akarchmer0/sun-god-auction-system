import test from "node:test";
import assert from "node:assert/strict";
import { PhoneRoomHub } from "../src/phone-room-hub.mjs";

const hostKey = "host_key_1234567890";
const phoneOne = "phone_token_123456";
const phoneTwo = "phone_token_987654";
const teams = [
  { id: "team-1", name: "Sun Kings", manager: "Alex", color: "#d39a20" },
  { id: "team-2", name: "Moon Club", manager: "Jordan", color: "#396b49" }
];

test("a phone room assigns teams and prevents duplicate claims", () => {
  const hub = new PhoneRoomHub({ now: () => 1000 });
  hub.upsertRoom({ roomId: "SUN222", hostKey, teams });
  const claimed = hub.claimTeam({ roomId: "sun222", teamId: "team-1", participantToken: phoneOne });
  assert.equal(claimed.claimedCount, 1);
  assert.equal(claimed.teams[0].claimed, true);
  assert.throws(
    () => hub.claimTeam({ roomId: "SUN222", teamId: "team-1", participantToken: phoneTwo }),
    /already connected/
  );
});

test("phone bids use the server clock and require an open auction", () => {
  let now = 2000;
  const hub = new PhoneRoomHub({ now: () => now });
  hub.upsertRoom({ roomId: "BDX222", hostKey, teams });
  hub.claimTeam({ roomId: "BDX222", teamId: "team-1", participantToken: phoneOne });
  assert.throws(
    () => hub.placeBid({ roomId: "BDX222", teamId: "team-1", participantToken: phoneOne }),
    /not open/
  );

  hub.updateAuction({
    roomId: "BDX222",
    hostKey,
    auction: { phase: "open", amount: 4, nextBid: 5, acceptingBids: true, player: { id: "puka", name: "Puka Nacua", position: "WR", nflTeam: "LAR" } },
    teams: teams.map((team) => ({ id: team.id, budget: 200, rosterCount: 0, rosterSize: 15, maxBid: 186 }))
  });
  now = 2450;
  const bid = hub.placeBid({ roomId: "BDX222", teamId: "team-1", participantToken: phoneOne });
  assert.equal(bid.receivedAt, 2450);
  assert.equal(bid.amount, 5);
});

test("room subscribers receive claim, state, and bid events", () => {
  let now = 3000;
  const hub = new PhoneRoomHub({ now: () => now });
  hub.upsertRoom({ roomId: "LVE222", hostKey, teams });
  const events = [];
  const unsubscribe = hub.subscribe("LVE222", (event) => events.push(event.type));
  hub.claimTeam({ roomId: "LVE222", teamId: "team-2", participantToken: phoneTwo });
  hub.updateAuction({
    roomId: "LVE222",
    hostKey,
    auction: { phase: "open", amount: 1, nextBid: 2, acceptingBids: true },
    teams: teams.map((team) => ({ id: team.id, budget: 200, rosterCount: 0, rosterSize: 15, maxBid: 186 }))
  });
  now = 3400;
  hub.placeBid({ roomId: "LVE222", teamId: "team-2", participantToken: phoneTwo });
  unsubscribe();
  assert.deepEqual(events, ["snapshot", "room", "state", "bid"]);
});
