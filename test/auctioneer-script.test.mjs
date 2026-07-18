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
