import test from "node:test";
import assert from "node:assert/strict";
import { createAuctioneerScript } from "../src/auctioneer-script.mjs";

test("phone bids receive short, varied, reactive acknowledgements", () => {
  const script = createAuctioneerScript();
  const first = script.bid({ amount: 35, manager: "Alex", nextAmount: 36, source: "phone" });
  const second = script.bid({ amount: 36, manager: "Jordan", nextAmount: 37, source: "phone" });
  assert.match(first, /Alex/);
  assert.match(first, /35/);
  assert.match(first, /36/);
  assert.match(second, /Jordan/);
  assert.notEqual(first, second);
});

test("auction script covers countdowns, rulings, and sales", () => {
  const script = createAuctioneerScript();
  assert.match(script.goingOnce(42), /42.*going once/i);
  assert.match(script.goingTwice(42), /going twice.*42|42.*going twice/i);
  assert.match(script.simultaneous({ amount: 43, managers: "Alex and Jordan" }), /simultaneous bids.*43.*Alex and Jordan/i);
  assert.match(script.sold({ player: { name: "Puka Nacua" }, team: { name: "Sun Kings", manager: "Alex" }, amount: 44 }), /Puka Nacua.*44|44.*Puka Nacua/i);
});

test("auctioneer personalities change the room voice and include preflight", () => {
  const classic = createAuctioneerScript({ personality: "classic" });
  const hype = createAuctioneerScript({ personality: "hype" });
  const pro = createAuctioneerScript({ personality: "pro" });
  const player = { name: "Puka Nacua", position: "WR", nflTeam: "LAR" };
  assert.notEqual(classic.nomination(player), hype.nomination(player));
  assert.notEqual(hype.nomination(player), pro.nomination(player));
  assert.match(classic.preflight(), /Can you hear Lucy/i);
  assert.match(hype.preflight(), /draft room/i);
});

test("continuous patter tracks the player, leader, price, and next bid", () => {
  const script = createAuctioneerScript({ personality: "hype" });
  const player = { name: "Puka Nacua", position: "WR", nflTeam: "LAR" };
  const opening = script.patter({ player, amount: 0, manager: null, nextAmount: 1, phase: "open", suggestedValue: 41 });
  const active = script.patter({ player, amount: 35, manager: "Alex", nextAmount: 36, phase: "open", suggestedValue: 41 });
  const urgent = script.patter({ player, amount: 35, manager: "Alex", nextAmount: 36, phase: "twice", suggestedValue: 41 });
  assert.match(opening, /Puka Nacua|WR/);
  assert.match(active, /Alex|Puka Nacua/);
  assert.match(active, /35/);
  assert.match(active, /36/);
  assert.notEqual(active, urgent);
});
