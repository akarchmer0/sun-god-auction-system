const SOUND_PREFERENCE_KEY = "sun-god-remote-audio";

export class RemotePhoneAudio {
  constructor({
    AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
    speechSynthesisImpl = globalThis.speechSynthesis,
    UtteranceImpl = globalThis.SpeechSynthesisUtterance,
    storage = globalThis.localStorage,
    onStateChange = () => {}
  } = {}) {
    this.AudioContextImpl = AudioContextImpl;
    this.speechSynthesis = speechSynthesisImpl;
    this.UtteranceImpl = UtteranceImpl;
    this.storage = storage;
    this.onStateChange = onStateChange;
    this.enabled = readPreference(storage);
    this.audioContext = null;
    this.active = null;
    this.ttsUnlocked = false;
    this.statusText = this.enabled ? "Tap the speaker to test phone audio." : "Phone audio is muted.";
    this.lastState = this.state;
  }

  get state() {
    if (!this.enabled) return "muted";
    if (!this.speechSynthesis || !this.UtteranceImpl) return "unsupported";
    return this.ttsUnlocked ? "on" : "needs-gesture";
  }

  async toggle() {
    if (this.enabled && this.state === "needs-gesture") return this.unlock({ announce: true });
    if (this.enabled) {
      this.enabled = false;
      writePreference(this.storage, false);
      this.cancel();
      this.statusText = "Phone audio is muted.";
      this.#reportState();
      return false;
    }
    this.enabled = true;
    writePreference(this.storage, true);
    await this.unlock({ announce: true });
    this.#reportState();
    return this.state === "on";
  }

  async unlock({ announce = false } = {}) {
    if (!this.enabled || !this.speechSynthesis || !this.UtteranceImpl) {
      this.statusText = this.enabled ? "Browser voice is unavailable on this phone." : "Phone audio is muted.";
      this.#reportState();
      return false;
    }
    if (this.AudioContextImpl) try {
      if (!this.audioContext) this.audioContext = new this.AudioContextImpl();
      if (this.audioContext.state === "suspended" && typeof this.audioContext.resume === "function") await this.audioContext.resume();
    } catch {}
    this.ttsUnlocked = true;
    this.statusText = "Phone audio is on — waiting for the auctioneer.";
    if (announce) this.#speakConfirmation();
    this.#reportState();
    return this.state === "on";
  }

  handleControl(message) {
    if (!message?.speechId || !String(message.type || "").startsWith("speech.")) return;
    if (message.type === "speech.audio") {
      if (this.active?.speechId === message.speechId) this.handleAudio(base64ToBytes(message.data));
      return;
    }
    if (message.type === "speech.cancel") {
      if (this.active?.speechId === message.speechId) this.cancel();
      return;
    }
    if (message.type === "speech.end") {
      if (this.active?.speechId !== message.speechId || this.active.kind === "fallback") return;
      this.active.streamDone = true;
      this.#finishWhenAudioEnds(this.active);
      return;
    }
    this.cancel();
    if (!this.enabled || this.state !== "on") return;
    if (message.type === "speech.start") {
      if (!this.audioContext || this.audioContext.state !== "running") {
        if (message.transcript) this.#speakFallback({ ...message, type: "speech.fallback" });
        else {
          this.statusText = "AI audio arrived, but this phone could not open its audio player.";
          this.#reportState(true);
        }
        return;
      }
      this.active = {
        speechId: message.speechId,
        kind: "pcm",
        sampleRate: Number(message.sampleRate) || 24_000,
        sources: new Set(),
        pendingSources: 0,
        nextStartTime: 0,
        streamDone: false,
        playedAudio: false
      };
      this.statusText = `AI voice connected${message.provider ? ` (${message.provider})` : ""}…`;
      this.#reportState(true);
      return;
    }
    if (message.type === "speech.fallback") this.#speakFallback(message);
  }

  handleAudio(payload) {
    const active = this.active;
    if (!this.enabled || this.state !== "on" || active?.kind !== "pcm") return false;
    const bytes = payload instanceof ArrayBuffer
      ? new Uint8Array(payload)
      : ArrayBuffer.isView(payload)
        ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
        : null;
    if (!bytes || bytes.byteLength < 2) return false;
    const samples = decodePcmBytes(bytes);
    if (!samples.length) return false;
    const context = this.audioContext;
    if ((active.nextStartTime || context.currentTime) - context.currentTime > 3) return false;
    const buffer = context.createBuffer(1, samples.length, active.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const now = context.currentTime;
    const startAt = Math.max(active.nextStartTime || now + 0.055, now + 0.018);
    active.nextStartTime = startAt + buffer.duration;
    active.sources.add(source);
    active.pendingSources += 1;
    source.onended = () => {
      active.sources.delete(source);
      active.pendingSources = Math.max(0, active.pendingSources - 1);
      this.#finishWhenAudioEnds(active);
    };
    source.start(startAt);
    if (!active.playedAudio) {
      active.playedAudio = true;
      this.statusText = "Playing the commissioner’s AI voice.";
      this.#reportState(true);
    }
    return true;
  }

  handleVisibilityChange(hidden) {
    if (hidden) return;
    this.#reportState();
  }

  cancel() {
    const active = this.active;
    this.active = null;
    for (const source of active?.sources || []) {
      try { source.stop(); } catch {}
    }
    this.speechSynthesis?.cancel();
  }

  #speakFallback(message) {
    if (!this.speechSynthesis || !this.UtteranceImpl) return;
    const utterance = new this.UtteranceImpl(String(message.transcript || ""));
    const performance = message.performance || {};
    const energy = Math.min(3, Math.max(1, Number(performance.energy) || 2));
    const personalityRate = ({ classic: 0, hype: 0.08, pro: 0.05 })[performance.personality] || 0;
    const styleRate = performance.style === "countdown" ? -0.04 : ["bid", "patter"].includes(performance.style) ? 0.06 : performance.style === "roast" ? -0.02 : 0;
    const speedRate = ({ measured: -0.12, normal: 0, fast: 0.12, fastest: 0.24 })[performance.speed] || 0;
    utterance.rate = Number(Math.min(2, 1.03 + (energy - 2) * 0.08 + personalityRate + styleRate + speedRate).toFixed(2));
    utterance.pitch = performance.personality === "hype" ? 1.04 : performance.personality === "pro" ? 0.94 : 1;
    const voices = this.speechSynthesis.getVoices?.() || [];
    utterance.voice = voices.find((voice) => /Samantha|Karen|Moira|Google UK English Female|Microsoft Sonia/i.test(voice.name))
      || voices.find((voice) => String(voice.lang || "").startsWith("en"))
      || null;
    const active = { speechId: message.speechId, kind: "fallback", sources: new Set(), utterance };
    this.active = active;
    this.statusText = `Speaking: ${utterance.text}`;
    utterance.onstart = () => { this.statusText = `Speaking: ${utterance.text}`; this.#reportState(true); };
    utterance.onend = () => {
      if (this.active === active) this.active = null;
      this.statusText = "Phone audio is on — waiting for the auctioneer.";
      this.#reportState(true);
    };
    utterance.onerror = (event) => {
      if (this.active === active) this.active = null;
      this.statusText = `Phone voice error: ${event?.error || "speech failed"}. Tap the speaker to test again.`;
      this.#reportState(true);
    };
    this.#speakUtterance(utterance);
    this.#reportState(true);
  }

  #speakConfirmation() {
    if (!this.speechSynthesis || !this.UtteranceImpl) return;
    const utterance = new this.UtteranceImpl("Phone audio on.");
    utterance.rate = 1.05;
    const active = { speechId: "phone-audio-test", kind: "confirmation", sources: new Set(), utterance };
    this.active = active;
    this.statusText = "Testing phone voice…";
    utterance.onstart = () => { this.statusText = "Phone voice test is playing."; this.#reportState(true); };
    utterance.onend = () => {
      if (this.active === active) this.active = null;
      this.statusText = "Phone audio is on — waiting for the auctioneer.";
      this.#reportState(true);
    };
    utterance.onerror = (event) => {
      if (this.active === active) this.active = null;
      this.statusText = `Phone voice error: ${event?.error || "speech failed"}. Check media volume and silent mode.`;
      this.#reportState(true);
    };
    this.#speakUtterance(utterance);
    this.#reportState(true);
  }

  #speakUtterance(utterance) {
    // Mobile Safari may drop unreferenced utterances and can ignore speak()
    // when it immediately follows cancel() in the same JavaScript task.
    this.speechSynthesis.cancel();
    globalThis.setTimeout(() => {
      if (this.active?.utterance !== utterance || !this.enabled) return;
      this.speechSynthesis.speak(utterance);
    }, 0);
  }

  #finishWhenAudioEnds(active) {
    if (this.active === active && active.streamDone && active.pendingSources === 0) {
      this.active = null;
      this.statusText = "Phone audio is on — waiting for the auctioneer.";
      this.#reportState(true);
    }
  }

  #reportState(force = false) {
    const next = this.state;
    if (!force && next === this.lastState) return;
    this.lastState = next;
    try { this.onStateChange(next); } catch {}
  }
}

export function decodePcmBytes(bytes) {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const signed = (bytes[index * 2 + 1] << 8) | bytes[index * 2];
    samples[index] = (signed & 0x8000 ? signed - 0x10000 : signed) / 32768;
  }
  return samples;
}

function base64ToBytes(value) {
  const binary = globalThis.atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readPreference(storage) {
  try { return storage?.getItem(SOUND_PREFERENCE_KEY) !== "off"; }
  catch { return true; }
}

function writePreference(storage, enabled) {
  try { storage?.setItem(SOUND_PREFERENCE_KEY, enabled ? "on" : "off"); } catch {}
}
