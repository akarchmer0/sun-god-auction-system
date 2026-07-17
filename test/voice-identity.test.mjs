import test from "node:test";
import assert from "node:assert/strict";
import { VoiceIdentityService } from "../src/voice-identity.mjs";

function serviceWithProfiles() {
  const service = new VoiceIdentityService({ threshold: 0.52, margin: 0.08 });
  service.profiles = new Map([
    ["alex", { bytes: new Uint8Array([1]) }],
    ["jordan", { bytes: new Uint8Array([2]) }],
    ["sam", { bytes: new Uint8Array([3]) }]
  ]);
  return service;
}

test("voice identity accepts a strong speaker with a clear margin", () => {
  const service = serviceWithProfiles();
  const now = Date.now();
  service.scoreHistory = [
    { at: now - 300, scores: { alex: 0.82, jordan: 0.31, sam: 0.14 } },
    { at: now - 100, scores: { alex: 0.78, jordan: 0.28, sam: 0.12 } }
  ];
  const result = service.resolveIdentity();
  assert.equal(result.status, "matched");
  assert.equal(result.teamId, "alex");
  assert.ok(result.confidence > 0.75);
});

test("voice identity asks for confirmation when top speakers are too close", () => {
  const service = serviceWithProfiles();
  service.scoreHistory = [
    { at: Date.now(), scores: { alex: 0.64, jordan: 0.59, sam: 0.18 } }
  ];
  const result = service.resolveIdentity();
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.candidates.slice(0, 2).map((item) => item.teamId), ["alex", "jordan"]);
});

test("voice identity rejects low-confidence and stale audio", () => {
  const service = serviceWithProfiles();
  service.scoreHistory = [
    { at: Date.now() - 100, scores: { alex: 0.41, jordan: 0.32, sam: 0.2 } }
  ];
  assert.equal(service.resolveIdentity().status, "unknown");
  service.scoreHistory = [
    { at: Date.now() - 6000, scores: { alex: 0.95, jordan: 0.05, sam: 0.02 } }
  ];
  assert.equal(service.resolveIdentity().status, "unknown");
});
