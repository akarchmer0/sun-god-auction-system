import test from "node:test";
import assert from "node:assert/strict";
import { parseTeamSetupLines } from "../src/data.mjs";

test("team setup parsing ignores blank lines without shifting checklist names", () => {
  assert.deepEqual(
    parseTeamSetupLines("Alpha Squad | Alex\n\nBravo Squad | Blair\n  \nCharlie Squad | Casey"),
    [
      { name: "Alpha Squad", manager: "Alex" },
      { name: "Bravo Squad", manager: "Blair" },
      { name: "Charlie Squad", manager: "Casey" }
    ]
  );
});

test("team setup parsing handles a team-only line and keeps manager punctuation", () => {
  assert.deepEqual(parseTeamSetupLines("Solo Team\nPipe Dreams | Alex | Jr."), [
    { name: "Solo Team", manager: "" },
    { name: "Pipe Dreams", manager: "Alex | Jr." }
  ]);
});
