import test from "node:test";
import assert from "node:assert/strict";
import { pcm16Base64, resample, rms } from "../src/realtime-transcriber.mjs";

test("realtime transcriber calculates signal energy for voice activity detection", () => {
  assert.equal(rms(new Float32Array([0, 0, 0])), 0);
  assert.ok(rms(new Float32Array([0.1, -0.1, 0.1, -0.1])) > 0.09);
});

test("realtime transcriber produces 24 kHz PCM16 payloads", () => {
  const samples = resample(new Float32Array([0, 1, -1, 0]), 12000, 24000);
  assert.equal(samples.length, 8);
  assert.equal(Buffer.from(pcm16Base64(new Float32Array([0, 1, -1])), "base64").length, 6);
});
