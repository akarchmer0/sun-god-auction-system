export class AuctioneerVoice {
  constructor({
    endpoint = "/api/auctioneer/speech",
    statusEndpoint = "/api/auctioneer/status",
    fetchImpl = globalThis.fetch?.bind(globalThis),
    AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
    speechSynthesisImpl = globalThis.speechSynthesis,
    UtteranceImpl = globalThis.SpeechSynthesisUtterance,
    onStatusChange = () => {}
  } = {}) {
    this.endpoint = endpoint;
    this.statusEndpoint = statusEndpoint;
    this.fetchImpl = fetchImpl;
    this.AudioContextImpl = AudioContextImpl;
    this.speechSynthesis = speechSynthesisImpl;
    this.UtteranceImpl = UtteranceImpl;
    this.onStatusChange = onStatusChange;
    this.audioContext = null;
    this.active = null;
    this.status = { status: "checking", available: null, provider: "cartesia", message: "Checking Cartesia voice." };
  }

  async initialize() {
    try {
      const response = await this.fetchImpl(this.statusEndpoint);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Cartesia status is unavailable.");
      this.#setStatus({ ...payload, status: payload.available ? "ready" : "fallback" });
    } catch (error) {
      this.#setStatus({ status: "fallback", available: false, provider: "browser", message: error.message });
    }
    return this.status;
  }

  get isSpeaking() {
    return Boolean(this.active);
  }

  speak(text, { style = "neutral", priority = 0, onDone } = {}) {
    const transcript = String(text || "").trim();
    if (!transcript) { onDone?.(); return; }
    this.cancel();
    const active = {
      id: Symbol("auctioneer-speech"),
      priority,
      onDone,
      abortController: new AbortController(),
      sources: new Set(),
      pendingSources: 0,
      streamDone: false,
      playedAudio: false,
      finished: false,
      nextStartTime: 0
    };
    this.active = active;
    if (this.status.available === false || !this.AudioContextImpl) {
      this.#speakWithBrowser(transcript, active);
      return;
    }
    void this.#streamCartesia(transcript, style, active);
  }

  cancel() {
    const active = this.active;
    if (!active) {
      this.speechSynthesis?.cancel();
      return;
    }
    this.active = null;
    active.finished = true;
    active.abortController.abort();
    for (const source of active.sources) {
      try { source.stop(); } catch {}
    }
    active.sources.clear();
    this.speechSynthesis?.cancel();
  }

  async #streamCartesia(transcript, style, active) {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: transcript, style }),
        signal: active.abortController.signal
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Cartesia speech is unavailable.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (this.active === active) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.#handleStreamEvent(JSON.parse(line), active);
        }
        if (done) break;
      }
      active.streamDone = true;
      this.#finishWhenAudioEnds(active);
    } catch (error) {
      if (error?.name === "AbortError" || this.active !== active) return;
      const retryable = this.status.configured !== false;
      this.#setStatus({ status: "fallback", available: retryable, provider: retryable ? "cartesia" : "browser", message: `${error.message} Browser voice fallback is active for this announcement.` });
      if (!active.playedAudio) this.#speakWithBrowser(transcript, active);
      else this.#finish(active);
    }
  }

  #handleStreamEvent(event, active) {
    if (this.active !== active) return;
    if (event.type === "start") {
      active.sampleRate = Number(event.sampleRate) || 24_000;
      return;
    }
    if (event.type === "audio" && event.data) {
      this.#schedulePcm(event.data, active.sampleRate || 24_000, active);
      return;
    }
    if (event.type === "error") throw new Error(event.message || "Cartesia speech failed.");
    if (event.type === "done") {
      active.streamDone = true;
      this.#finishWhenAudioEnds(active);
    }
  }

  #schedulePcm(base64, sampleRate, active) {
    const samples = decodePcm16(base64);
    if (!samples.length || this.active !== active) return;
    if (!this.audioContext) this.audioContext = new this.AudioContextImpl({ sampleRate });
    if (this.audioContext.state === "suspended") void this.audioContext.resume();
    const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    const now = this.audioContext.currentTime;
    const startAt = Math.max(active.nextStartTime || now + 0.035, now + 0.012);
    active.nextStartTime = startAt + buffer.duration;
    active.sources.add(source);
    active.pendingSources += 1;
    active.playedAudio = true;
    source.onended = () => {
      active.sources.delete(source);
      active.pendingSources = Math.max(0, active.pendingSources - 1);
      this.#finishWhenAudioEnds(active);
    };
    source.start(startAt);
  }

  #finishWhenAudioEnds(active) {
    if (active.streamDone && active.pendingSources === 0) this.#finish(active);
  }

  #speakWithBrowser(transcript, active) {
    if (!this.speechSynthesis || !this.UtteranceImpl || this.active !== active) return this.#finish(active);
    this.speechSynthesis.cancel();
    const utterance = new this.UtteranceImpl(transcript);
    utterance.rate = 1.08;
    utterance.pitch = 0.84;
    const voices = this.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => /Daniel|Alex|Google UK English Male/i.test(voice.name))
      || voices.find((voice) => voice.lang.startsWith("en"))
      || null;
    utterance.onend = () => this.#finish(active);
    utterance.onerror = () => this.#finish(active);
    this.speechSynthesis.speak(utterance);
  }

  #finish(active) {
    if (active.finished || this.active !== active) return;
    active.finished = true;
    this.active = null;
    active.onDone?.();
  }

  #setStatus(nextStatus) {
    this.status = { ...this.status, ...nextStatus };
    this.onStatusChange(this.status);
  }
}

export function decodePcm16(base64) {
  const binary = globalThis.atob(base64);
  const sampleCount = Math.floor(binary.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const signed = (high << 8) | low;
    samples[index] = (signed & 0x8000 ? signed - 0x10000 : signed) / 32768;
  }
  return samples;
}
