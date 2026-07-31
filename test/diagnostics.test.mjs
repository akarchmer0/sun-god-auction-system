import test from "node:test";
import assert from "node:assert/strict";
import { createStoredZip } from "../electron/diagnostics.mjs";

test("redacted diagnostics use a valid uncompressed ZIP container", () => {
  const zip = createStoredZip({ "diagnostics.json": JSON.stringify({ version: 1 }) });
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.match(zip.toString("latin1"), /diagnostics\.json/);
});
