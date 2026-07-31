import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateDraftState } from "./draft-state-validation.mjs";

export class DraftStore {
  constructor({ directory, checkpointCount = 20, now = () => Date.now() }) {
    if (!directory) throw new Error("Draft storage directory is required.");
    this.directory = directory;
    this.checkpointDirectory = join(directory, "checkpoints");
    this.currentPath = join(directory, "current.json");
    this.checkpointCount = checkpointCount;
    this.now = now;
  }

  async load() {
    await this.#initialize();
    const candidates = [this.currentPath, ...(await this.#checkpointPaths())];
    for (const [index, path] of candidates.entries()) {
      try {
        const envelope = verifyEnvelope(JSON.parse(await readFile(path, "utf8")));
        return { ...envelope, recoveredFromCheckpoint: index > 0 };
      } catch (error) {
        if (error?.code !== "ENOENT" && path !== this.currentPath) continue;
      }
    }
    return { version: 1, revision: 0, savedAt: null, state: null, recoveredFromCheckpoint: false };
  }

  async save(state, { expectedRevision = null } = {}) {
    validateDraftState(state);
    await this.#initialize();
    const current = await this.load();
    if (expectedRevision != null && Number(expectedRevision) !== current.revision) {
      const error = new Error("Draft state changed in another commissioner session.");
      error.status = 409;
      error.currentRevision = current.revision;
      throw error;
    }
    const envelope = makeEnvelope(state, current.revision + 1, this.now());
    const tempPath = join(this.directory, `.current-${randomUUID()}.tmp`);
    await writeDurably(tempPath, `${JSON.stringify(envelope)}\n`);
    if (current.state) {
      const checkpointPath = join(this.checkpointDirectory, `${String(current.revision).padStart(10, "0")}-${current.savedAt || 0}.json`);
      await writeDurably(checkpointPath, `${JSON.stringify(makeEnvelope(current.state, current.revision, current.savedAt))}\n`);
    }
    await rename(tempPath, this.currentPath);
    await this.#trimCheckpoints();
    return { ...envelope, recoveredFromCheckpoint: false };
  }

  async importBackup(value) {
    if (value?.format === "sun-god-emergency-backup-v1") {
      validateDraftState(value.state);
      return this.save(value.state);
    }
    const envelope = verifyEnvelope(value);
    return this.save(envelope.state);
  }

  async #initialize() {
    await mkdir(this.checkpointDirectory, { recursive: true, mode: 0o700 });
  }

  async #checkpointPaths() {
    const entries = await readdir(this.checkpointDirectory).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    return entries.filter((name) => name.endsWith(".json")).sort().reverse().map((name) => join(this.checkpointDirectory, name));
  }

  async #trimCheckpoints() {
    const paths = await this.#checkpointPaths();
    await Promise.all(paths.slice(this.checkpointCount).map((path) => rm(path, { force: true })));
  }
}

function makeEnvelope(state, revision, savedAt) {
  const stateJson = JSON.stringify(state);
  return { version: 1, revision, savedAt, checksum: createHash("sha256").update(stateJson).digest("hex"), state };
}

function verifyEnvelope(envelope) {
  if (envelope?.version !== 1 || !Number.isInteger(envelope?.revision) || envelope.revision < 1 || !envelope?.state) throw new Error("Draft snapshot format is invalid.");
  validateDraftState(envelope.state);
  const expected = createHash("sha256").update(JSON.stringify(envelope.state)).digest("hex");
  if (envelope.checksum !== expected) throw new Error("Draft snapshot checksum failed.");
  return envelope;
}

async function writeDurably(path, contents) {
  const file = await open(path, "w", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
