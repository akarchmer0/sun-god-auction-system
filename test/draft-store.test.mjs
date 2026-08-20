import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DraftStore } from "../src/draft-store.mjs";
import { createDraft } from "../src/domain.mjs";
import { makeTeams } from "../src/data.mjs";
import { fantasyProsPlayers } from "../src/fantasy-pros-data.mjs";

function sampleDraft() {
  return createDraft({ players: fantasyProsPlayers.slice(0, 4), teams: makeTeams(2), rosterSize: 2, rosterRequirements: { WR: 1 } });
}

test("draft store saves atomically, detects conflicts, and recovers a checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sun-god-store-"));
  let now = 1_000;
  const store = new DraftStore({ directory, now: () => now });
  const first = await store.save(sampleDraft(), { expectedRevision: 0 });
  assert.equal(first.revision, 1);
  now = 2_000;
  const changed = { ...first.state, log: [...first.state.log, { id: "log-safe", type: "system", message: "Saved", at: now }] };
  const second = await store.save(changed, { expectedRevision: 1 });
  assert.equal(second.revision, 2);
  await assert.rejects(() => store.save(changed, { expectedRevision: 1 }), /another commissioner session/);

  await writeFile(join(directory, "current.json"), "{corrupt", "utf8");
  const recovered = await store.load();
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.recoveredFromCheckpoint, true);
  assert.match(await readFile(join(directory, "checkpoints", "0000000001-1000.json"), "utf8"), /checksum/);
});

test("draft store rejects malformed persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sun-god-invalid-"));
  const store = new DraftStore({ directory });
  await assert.rejects(() => store.save({ players: [] }), /1–5,000 players/);
});
