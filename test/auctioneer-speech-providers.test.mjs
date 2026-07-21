import test from "node:test";
import assert from "node:assert/strict";
import { selectSpeechProvider, speechProviderCandidates, speechProviderStatus } from "../src/auctioneer-speech-providers.mjs";

const service = (provider, available) => ({ status: () => ({ provider, available, message: `${provider} status` }) });

test("auto prefers ElevenLabs and falls through to Cartesia", () => {
  const elevenlabs = service("elevenlabs", true);
  const cartesia = service("cartesia", true);
  assert.equal(selectSpeechProvider("auto", { elevenlabs, cartesia }), elevenlabs);
  assert.deepEqual(speechProviderCandidates("auto", { elevenlabs, cartesia }), [elevenlabs, cartesia]);
  elevenlabs.status = () => ({ provider: "elevenlabs", available: false });
  assert.equal(selectSpeechProvider("auto", { elevenlabs, cartesia }), cartesia);
});

test("an unavailable explicit provider does not silently change realtime voices", () => {
  const providers = { elevenlabs: service("elevenlabs", false), cartesia: service("cartesia", true) };
  assert.equal(selectSpeechProvider("elevenlabs", providers), null);
  const status = speechProviderStatus("elevenlabs", Object.fromEntries(Object.entries(providers).map(([id, value]) => [id, value.status()])));
  assert.equal(status.provider, "browser");
  assert.match(status.message, /Browser voice fallback/);
});
