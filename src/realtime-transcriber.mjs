const TARGET_SAMPLE_RATE = 24000;
const SPEECH_THRESHOLD = 0.009;
const SILENCE_TO_COMMIT_MS = 1400;
const PRE_ROLL_MS = 260;

export class RealtimeTranscriber {
  constructor({ onTranscript, onInterim, onStateChange, onError } = {}) {
    this.onTranscript = onTranscript || (() => {});
    this.onInterim = onInterim || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onError = onError || (() => {});
    this.socket = null;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this.sampleRate = 48000;
    this.activeSpeech = false;
    this.silenceMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;
    this.partialByItem = new Map();
    this.generation = 0;
    this.status = "idle";
  }

  get isSupported() {
    return Boolean(
      globalThis.fetch
      && globalThis.WebSocket
      && globalThis.navigator?.mediaDevices?.getUserMedia
      && (globalThis.AudioContext || globalThis.webkitAudioContext)
    );
  }

  async start() {
    if (this.status === "listening" || this.status === "connecting") return;
    if (!this.isSupported) throw new Error("OpenAI live transcription needs a current browser with microphone and WebSocket support.");
    const generation = ++this.generation;
    this._setStatus("connecting");
    try {
      const session = await requestRealtimeSession();
      if (generation !== this.generation) return;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      if (generation !== this.generation) return this.stop();
      await this._openSocket(session.value, generation);
      if (generation !== this.generation) return this.stop();
      await this._startAudioPipeline();
      this._setStatus("listening");
    } catch (error) {
      await this.stop();
      throw new Error(cleanError(error));
    }
  }

  async stop() {
    this.generation += 1;
    this.activeSpeech = false;
    this.silenceMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;
    this.partialByItem.clear();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
    this.socket = null;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this._setStatus("idle");
  }

  async _openSocket(ephemeralKey, generation) {
    const socket = new WebSocket(
      "wss://api.openai.com/v1/realtime",
      ["realtime", `openai-insecure-api-key.${ephemeralKey}`]
    );
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("OpenAI transcription took too long to connect.")), 9000);
      socket.onopen = () => { window.clearTimeout(timer); resolve(); };
      socket.onerror = () => { window.clearTimeout(timer); reject(new Error("OpenAI transcription could not connect.")); };
    });
    if (generation !== this.generation) { socket.close(); return; }
    this.socket = socket;
    socket.onmessage = (event) => this._handleServerEvent(event.data);
    socket.onerror = () => this._handleSocketError("OpenAI live transcription encountered a connection error.");
    socket.onclose = () => {
      if (this.status !== "idle") this._handleSocketError("OpenAI live transcription disconnected. Turn the mic back on to reconnect.");
    };
    this._send({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: TARGET_SAMPLE_RATE },
            transcription: { model: "gpt-realtime-whisper", language: "en", delay: "high" },
            turn_detection: null
          }
        }
      }
    });
  }

  async _startAudioPipeline() {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.context = new AudioContext();
    this.sampleRate = this.context.sampleRate;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;
    this.processor.onaudioprocess = (event) => this._handleAudio(event.inputBuffer.getChannelData(0));
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
    await this.context.resume();
  }

  _handleAudio(input) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const frame = resample(input, this.sampleRate, TARGET_SAMPLE_RATE);
    const durationMs = frame.length / TARGET_SAMPLE_RATE * 1000;
    const speech = rms(input) >= SPEECH_THRESHOLD;
    const encoded = pcm16Base64(frame);

    if (!this.activeSpeech) {
      this._rememberPreRoll(encoded, durationMs);
      if (!speech) return;
      this.activeSpeech = true;
      this.silenceMs = 0;
      for (const chunk of this.preRoll) this._append(chunk.audio);
      this.preRoll = [];
      this.preRollMs = 0;
      return;
    }

    this._append(encoded);
    this.silenceMs = speech ? 0 : this.silenceMs + durationMs;
    if (this.silenceMs >= SILENCE_TO_COMMIT_MS) {
      this._send({ type: "input_audio_buffer.commit" });
      this.activeSpeech = false;
      this.silenceMs = 0;
    }
  }

  _rememberPreRoll(audio, durationMs) {
    this.preRoll.push({ audio, durationMs });
    this.preRollMs += durationMs;
    while (this.preRollMs > PRE_ROLL_MS && this.preRoll.length) this.preRollMs -= this.preRoll.shift().durationMs;
  }

  _append(audio) {
    this._send({ type: "input_audio_buffer.append", audio });
  }

  _send(event) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  _handleServerEvent(raw) {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      const next = `${this.partialByItem.get(event.item_id) || ""}${event.delta || ""}`;
      this.partialByItem.set(event.item_id, next);
      this.onInterim(next);
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      this.partialByItem.delete(event.item_id);
      const transcript = String(event.transcript || "").trim();
      if (transcript) this.onTranscript(transcript);
      return;
    }
    if (event.type === "error") this._handleSocketError(event.error?.message || "OpenAI live transcription reported an error.");
  }

  _handleSocketError(message) {
    this._setStatus("error", cleanError(message));
    this.onError(cleanError(message));
  }

  _setStatus(status, error = null) {
    this.status = status;
    this.onStateChange({ status, error });
  }
}

export function rms(samples) {
  if (!samples?.length) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length);
}

export function resample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return new Float32Array(input);
  const outputLength = Math.round(input.length * outputRate / inputRate);
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const before = Math.floor(position);
    const after = Math.min(before + 1, input.length - 1);
    output[index] = input[before] + (input[after] - input[before]) * (position - before);
  }
  return output;
}

export function pcm16Base64(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    bytes[index * 2] = value & 0xff;
    bytes[index * 2 + 1] = (value >> 8) & 0xff;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function requestRealtimeSession() {
  const response = await fetch("/api/transcription/session", { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.value) throw new Error(payload.error || "OpenAI transcription is not configured.");
  return payload;
}

function cleanError(error) {
  return (error?.message || String(error || "OpenAI transcription failed")).replace(/^Error:\s*/i, "");
}
