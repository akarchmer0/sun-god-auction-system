const DB_NAME = "gavel-sherpa-voiceprints";
const DB_VERSION = 1;
const STORE_NAME = "profiles";

export class VoiceIdentityService {
  constructor({ onStateChange, onScores, threshold = 0.56, margin = 0.07 } = {}) {
    this.onStateChange = onStateChange || (() => {});
    this.onScores = onScores || (() => {});
    this.threshold = threshold;
    this.margin = margin;
    this.status = "ready";
    this.error = null;
    this.profiles = new Map();
    this.enrollingTeamId = null;
    this.enrollmentProgress = 0;
    this.isRecognizing = false;
    this.scoreHistory = [];
    this.latestScores = {};
    this.capture = new LocalAudioCapture();
    this._enrollmentTimer = null;
    this._completionTimer = null;
    this._enrollmentBusy = false;
  }

  get isSupported() {
    return Boolean(
      globalThis.indexedDB
      && globalThis.fetch
      && globalThis.navigator?.mediaDevices?.getUserMedia
      && (globalThis.AudioContext || globalThis.webkitAudioContext)
    );
  }

  get profileTeamIds() {
    return [...this.profiles.keys()];
  }

  hasProfile(teamId) {
    return this.profiles.has(teamId);
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      profileTeamIds: this.profileTeamIds,
      enrollingTeamId: this.enrollingTeamId,
      enrollmentProgress: this.enrollmentProgress,
      isRecognizing: this.isRecognizing,
      latestScores: { ...this.latestScores }
    };
  }

  async loadStoredProfiles() {
    if (!globalThis.indexedDB) {
      this.status = "unsupported";
      this.error = "This browser does not support local voiceprint storage.";
      this._emit();
      return;
    }
    const records = await dbGetAll();
    this.profiles = new Map(records
      .filter((record) => record.embedding)
      .map((record) => [record.teamId, { embedding: new Float32Array(record.embedding) }]));
    this.status = "ready";
    this._emit();
  }

  async beginEnrollment(teamId) {
    if (!this.isSupported) throw new Error("Local speaker recognition is unavailable in this browser.");
    await this.stopRecognition();
    await this.cancelEnrollment();
    try {
      await this.capture.start();
      this.capture.clear();
    } catch (error) {
      throw new Error(`Microphone access is required to enroll a voice: ${cleanError(error)}`);
    }
    this.enrollingTeamId = teamId;
    this.enrollmentProgress = 0;
    this.status = "enrolling";
    this.error = null;
    this._emit();

    const startedAt = Date.now();
    this._enrollmentTimer = window.setInterval(() => {
      if (!this.enrollingTeamId) return;
      this.enrollmentProgress = Math.min(99, Math.round(((Date.now() - startedAt) / 6000) * 100));
      this._emit();
    }, 150);
    this._completionTimer = window.setTimeout(() => this._completeEnrollment(), 6100);
  }

  async _completeEnrollment() {
    const teamId = this.enrollingTeamId;
    if (!teamId || this._enrollmentBusy) return;
    this._enrollmentBusy = true;
    this._clearEnrollmentTimers();
    try {
      const samples = this.capture.recent(6.0);
      const embedding = await requestEmbedding(samples);
      this.profiles.set(teamId, { embedding });
      await dbPut({ teamId, embedding: embedding.buffer.slice(0), updatedAt: Date.now() });
      this.enrollmentProgress = 100;
      this.status = "ready";
    } catch (error) {
      this.status = "ready";
      this.error = cleanError(error);
    } finally {
      this.enrollingTeamId = null;
      this._enrollmentBusy = false;
      await this.capture.stop();
      this._emit();
    }
  }

  async cancelEnrollment() {
    this._clearEnrollmentTimers();
    if (!this.enrollingTeamId && !this._enrollmentBusy) return;
    this.enrollingTeamId = null;
    this.enrollmentProgress = 0;
    this._enrollmentBusy = false;
    this.status = "ready";
    await this.capture.stop();
    this._emit();
  }

  async deleteProfile(teamId) {
    const resume = this.isRecognizing;
    await this.stopRecognition();
    this.profiles.delete(teamId);
    delete this.latestScores[teamId];
    await dbDelete(teamId);
    this._emit();
    if (resume && this.profiles.size) await this.startRecognition();
  }

  async deleteAllProfiles() {
    await this.stopRecognition();
    await this.cancelEnrollment();
    this.profiles.clear();
    this.latestScores = {};
    this.scoreHistory = [];
    await dbClear();
    this.status = "ready";
    this._emit();
  }

  async startRecognition() {
    if (this.isRecognizing) return true;
    if (!this.profiles.size || this.enrollingTeamId) return false;
    try {
      await this.capture.start();
      this.isRecognizing = true;
      this.status = "recognizing";
      this.error = null;
      this._emit();
      return true;
    } catch (error) {
      this.error = `Microphone access is required for speaker recognition: ${cleanError(error)}`;
      this.status = "ready";
      this._emit();
      throw new Error(this.error);
    }
  }

  async stopRecognition() {
    this.isRecognizing = false;
    this.scoreHistory = [];
    if (this.status === "recognizing") this.status = "ready";
    await this.capture.stop();
    this._emit();
  }

  async identifyRecent() {
    if (!this.isRecognizing || !this.profiles.size) return { status: "unknown", confidence: 0, candidates: [] };
    try {
      const embedding = await requestEmbedding(this.capture.recent(3.25));
      const scores = Object.fromEntries(this.profileTeamIds.map((teamId) => [
        teamId,
        cosineSimilarity(embedding, this.profiles.get(teamId).embedding)
      ]));
      this.latestScores = scores;
      const now = Date.now();
      this.scoreHistory.push({ at: now, scores });
      this.scoreHistory = this.scoreHistory.filter((item) => item.at >= now - 5000);
      this.onScores({ ...scores });
      return this.resolveIdentity();
    } catch (error) {
      this.error = cleanError(error);
      this._emit();
      return { status: "unknown", confidence: 0, candidates: [], error: this.error };
    }
  }

  resolveIdentity(windowMs = 2800) {
    const cutoff = Date.now() - windowMs;
    const recent = this.scoreHistory.filter((item) => item.at >= cutoff);
    if (!recent.length) return { status: "unknown", confidence: 0, candidates: [] };
    const candidates = this.profileTeamIds.map((teamId) => {
      const values = recent.map((item) => item.scores[teamId] || 0).sort((a, b) => b - a).slice(0, 3);
      return { teamId, confidence: values.reduce((sum, value) => sum + value, 0) / values.length };
    }).sort((a, b) => b.confidence - a.confidence);
    const [best, second] = candidates;
    if (!best || best.confidence < this.threshold) return { status: "unknown", confidence: best?.confidence || 0, candidates: candidates.slice(0, 3) };
    if (second && best.confidence - second.confidence < this.margin) return { status: "ambiguous", confidence: best.confidence, candidates: candidates.slice(0, 3) };
    return { status: "matched", teamId: best.teamId, confidence: best.confidence, candidates: candidates.slice(0, 3) };
  }

  _clearEnrollmentTimers() {
    if (this._enrollmentTimer) window.clearInterval(this._enrollmentTimer);
    if (this._completionTimer) window.clearTimeout(this._completionTimer);
    this._enrollmentTimer = null;
    this._completionTimer = null;
  }

  _emit() {
    this.onStateChange(this.snapshot());
  }
}

class LocalAudioCapture {
  constructor() {
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this.chunks = [];
    this.sampleCount = 0;
    this.sampleRate = 48000;
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.context = new AudioContext();
    this.sampleRate = this.context.sampleRate;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;
    this.processor.onaudioprocess = (event) => this._append(event.inputBuffer.getChannelData(0));
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
    await this.context.resume();
  }

  async stop() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this.clear();
  }

  clear() {
    this.chunks = [];
    this.sampleCount = 0;
  }

  recent(seconds, targetRate = 16000) {
    const desiredSamples = Math.min(this.sampleCount, Math.ceil(seconds * this.sampleRate));
    const startAt = this.sampleCount - desiredSamples;
    const input = new Float32Array(desiredSamples);
    let readOffset = 0;
    let outputOffset = 0;
    for (const chunk of this.chunks) {
      const nextOffset = readOffset + chunk.length;
      if (nextOffset > startAt) {
        const from = Math.max(0, startAt - readOffset);
        const length = Math.min(chunk.length - from, desiredSamples - outputOffset);
        input.set(chunk.subarray(from, from + length), outputOffset);
        outputOffset += length;
      }
      readOffset = nextOffset;
      if (outputOffset >= desiredSamples) break;
    }
    return resample(input, this.sampleRate, targetRate);
  }

  _append(input) {
    const chunk = new Float32Array(input);
    this.chunks.push(chunk);
    this.sampleCount += chunk.length;
    const maxSamples = this.sampleRate * 10;
    while (this.sampleCount > maxSamples && this.chunks.length) {
      this.sampleCount -= this.chunks.shift().length;
    }
  }
}

async function requestEmbedding(samples) {
  if (samples.length < 19200) throw new Error("Keep speaking for at least two seconds so Sun God can identify the bidder.");
  const response = await fetch("/api/voice/embed", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Gavel-Sample-Rate": "16000"
    },
    body: samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(payload.embedding)) throw new Error(payload.error || "Local speaker recognition could not process that audio.");
  return new Float32Array(payload.embedding);
}

function resample(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
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

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return dot / Math.max(Math.sqrt(leftMagnitude * rightMagnitude), Number.EPSILON);
}

function cleanError(error) {
  return (error?.message || String(error || "Unknown speaker-recognition error")).replace(/^Error:\s*/i, "");
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "teamId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, operation) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

function dbGetAll() { return withStore("readonly", (store) => store.getAll()); }
function dbPut(record) { return withStore("readwrite", (store) => store.put(record)); }
function dbDelete(teamId) { return withStore("readwrite", (store) => store.delete(teamId)); }
function dbClear() { return withStore("readwrite", (store) => store.clear()); }
