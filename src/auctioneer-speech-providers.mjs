export const SPEECH_PROVIDER_IDS = Object.freeze(["auto", "elevenlabs", "cartesia"]);

export function selectSpeechProvider(preference, providers = {}) {
  return speechProviderCandidates(preference, providers)[0] || null;
}

export function speechProviderCandidates(preference, providers = {}) {
  const requested = SPEECH_PROVIDER_IDS.includes(preference) ? preference : "auto";
  if (requested !== "auto") {
    const service = providers[requested];
    return service?.status?.().available ? [service] : [];
  }
  return [providers.elevenlabs, providers.cartesia].filter((service) => service?.status?.().available);
}

export function speechProviderStatus(preference, statuses = {}) {
  const requested = SPEECH_PROVIDER_IDS.includes(preference) ? preference : "auto";
  const selected = requested === "auto"
    ? [statuses.elevenlabs, statuses.cartesia].find((status) => status?.available)
    : statuses[requested];
  if (selected?.available) return { ...selected, requestedProvider: requested };
  return {
    available: false,
    configured: false,
    connected: false,
    provider: "browser",
    requestedProvider: requested,
    model: null,
    voiceId: null,
    sampleRate: 24_000,
    message: requested === "auto"
      ? "No realtime voice provider is configured. Browser voice fallback is active."
      : `${statuses[requested]?.message || "That realtime provider is unavailable."} Browser voice fallback is active.`
  };
}
