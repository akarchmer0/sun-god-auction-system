import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYahooMarketValues, quadraticMarketCalibration } from "../src/yahoo-market-values.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const inputPath = process.argv[2] ? resolve(process.argv[2]) : null;
const outputPath = process.argv[3] ? resolve(process.argv[3]) : resolve(ROOT, "data/yahoo-market-values.json");

if (!inputPath) {
  process.stderr.write("Usage: node scripts/import-yahoo-market-values.mjs <pasted-yahoo.txt> [output.json]\n");
  process.exitCode = 1;
} else {
  const players = parseYahooMarketValues(await readFile(inputPath, "utf8"));
  if (!players.length) throw new Error("No Yahoo player values were found in the supplied file.");
  const payload = {
    importedAt: new Date().toISOString(),
    source: "Yahoo Fantasy current average and projected auction values",
    calibration: quadraticMarketCalibration(players),
    players
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`Imported ${players.length} Yahoo player values to ${outputPath}\n`);
}
