import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRelayRequest } from "../relay/worker.mjs";

const secret = "personal-relay-secret-that-is-long-enough";

test("personal relay room creation requires the configured admin secret", async () => {
  const env = { RELAY_ADMIN_SECRET: secret };
  assert.equal(await authorizeRelayRequest(new Request("https://relay.test/v1/rooms", { method: "POST" }), env), false);
  assert.equal(await authorizeRelayRequest(new Request("https://relay.test/v1/rooms", {
    method: "POST",
    headers: { Authorization: "Bearer wrong-secret-that-is-also-long-enough" }
  }), env), false);
  assert.equal(await authorizeRelayRequest(new Request("https://relay.test/v1/rooms", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` }
  }), env), true);
  assert.equal(await authorizeRelayRequest(new Request("https://relay.test/v1/rooms", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` }
  }), {}), false);
});
