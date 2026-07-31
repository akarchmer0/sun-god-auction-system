import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const relayUrl = String(process.env.SUN_GOD_RELAY_URL || "").trim().replace(/\/$/, "");
const relayAdminSecret = String(process.env.SUN_GOD_RELAY_ADMIN_SECRET || "").trim();
if ((relayUrl || relayAdminSecret) && (!/^https:\/\//i.test(relayUrl) || relayAdminSecret.length < 24)) {
  console.error("Set both SUN_GOD_RELAY_URL and a long SUN_GOD_RELAY_ADMIN_SECRET, or leave both unset and configure them in the personal app.");
  process.exit(2);
}
const source = `// Generated personal-build configuration. Do not commit real secrets.\nexport const BUILT_RELAY_URL = ${JSON.stringify(relayUrl)};\nexport const BUILT_RELAY_ADMIN_SECRET = ${JSON.stringify(relayAdminSecret)};\n`;
await writeFile(resolve("electron/release-config.mjs"), source, "utf8");
