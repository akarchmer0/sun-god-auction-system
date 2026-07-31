import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, utilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStoredZip } from "./diagnostics.mjs";
import { BUILT_RELAY_ADMIN_SECRET, BUILT_RELAY_URL } from "./release-config.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const preloadPath = fileURLToPath(new URL("preload.cjs", import.meta.url));
let hostServer;
let mainWindow;

app.setName("Sun God Auctioneer");
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => hostServer?.kill());

app.whenReady().then(startDesktopApp).catch(async (error) => {
  console.error(error);
  await dialog.showMessageBox({
    type: "error",
    title: "Sun God Auctioneer could not start",
    message: "The application could not start its local auction service.",
    detail: error instanceof Error ? error.message : String(error)
  });
  app.quit();
});

async function startDesktopApp() {
  if (process.platform !== "darwin" || process.arch !== "arm64" || Number.parseInt(process.getSystemVersion(), 10) < 14) {
    await dialog.showMessageBox({ type: "error", title: "Unsupported Mac", message: "Sun God requires an Apple Silicon Mac running macOS 14 or newer." });
    return app.quit();
  }
  registerIpc();
  const port = await availablePort();
  const hostToken = randomBytes(32).toString("base64url");
  hostServer = await launchHostServer({ port, hostToken });
  mainWindow = new BrowserWindow({
    width: 1480, height: 980, minWidth: 1100, minHeight: 760, show: false,
    title: "Sun God Auctioneer",
    webPreferences: {
      preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, additionalArguments: [`--sun-god-host-token=${hostToken}`]
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  if (!mainWindow.isVisible()) mainWindow.show();
}

function registerIpc() {
  ipcMain.handle("credentials:set", async (_event, credentials) => {
    const allowedKeys = new Set(["SUN_GOD_RELAY_URL", "SUN_GOD_RELAY_ADMIN_SECRET", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "CARTESIA_API_KEY"]);
    const allowed = Object.fromEntries(Object.entries(credentials || {}).filter(([key, value]) => allowedKeys.has(key) && typeof value === "string" && value.length <= 500));
    await writeCredentials({ ...(await readCredentials()), ...allowed });
    return { saved: true, restartRequired: true };
  });
  ipcMain.handle("relay-session:get", async () => (await readCredentials()).RELAY_SESSION || null);
  ipcMain.handle("relay-session:set", async (_event, value) => {
    const secrets = await readCredentials();
    if (value == null) delete secrets.RELAY_SESSION;
    else secrets.RELAY_SESSION = value;
    await writeCredentials(secrets);
    return true;
  });
  ipcMain.handle("diagnostics:export", async () => {
    const choice = await dialog.showSaveDialog({ defaultPath: `sun-god-diagnostics-${new Date().toISOString().slice(0, 10)}.zip` });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    let draft = {};
    try {
      const envelope = JSON.parse(await readFile(join(app.getPath("userData"), "current.json"), "utf8"));
      draft = { revision: envelope.revision, savedAt: envelope.savedAt, playerCount: envelope.state?.players?.length, teamCount: envelope.state?.teams?.length, saleCount: envelope.state?.sales?.length, phase: envelope.state?.auction?.phase };
    } catch {}
    const report = {
      generatedAt: new Date().toISOString(), appVersion: app.getVersion(), electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome, nodeVersion: process.versions.node, platform: process.platform,
      architecture: process.arch, macOS: process.getSystemVersion(), draft,
      privacy: "No API keys, room secrets, claim tokens, player names, team names, or manager names are included."
    };
    await writeFile(choice.filePath, createStoredZip({ "diagnostics.json": `${JSON.stringify(report, null, 2)}\n` }), { mode: 0o600 });
    return { canceled: false, path: choice.filePath };
  });
}

async function launchHostServer({ port, hostToken }) {
  const credentials = await readCredentials();
  const relayUrl = credentials.SUN_GOD_RELAY_URL || process.env.SUN_GOD_RELAY_URL || BUILT_RELAY_URL;
  const relayAdminSecret = credentials.SUN_GOD_RELAY_ADMIN_SECRET || process.env.SUN_GOD_RELAY_ADMIN_SECRET || BUILT_RELAY_ADMIN_SECRET;
  const child = utilityProcess.fork(join(appRoot, "server.mjs"), [], {
    env: {
      ...process.env, ...credentials, PORT: String(port),
      SUN_GOD_HOST_TOKEN: hostToken, SUN_GOD_DATA_DIR: app.getPath("userData"),
      SUN_GOD_RELAY_URL: relayUrl,
      SUN_GOD_RELAY_ADMIN_SECRET: relayAdminSecret
    },
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "Sun God Local Auction Service"
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The local auction service did not start.")), 10_000);
    child.once("exit", (code) => reject(new Error(`The local auction service exited with code ${code}.`)));
    child.once("error", (_type, location) => reject(new Error(`The local auction service failed at ${location}.`)));
    child.stderr?.on("data", (chunk) => console.error(chunk.toString().trim()));
    child.stdout?.on("data", (chunk) => { if (chunk.toString().includes(`localhost:${port}`)) { clearTimeout(timeout); resolve(); } });
  });
  return child;
}

async function readCredentials() {
  try {
    const value = JSON.parse(await readFile(join(app.getPath("userData"), "credentials.json"), "utf8"));
    if (!value.encrypted || !safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(Buffer.from(value.encrypted, "base64")));
  } catch { return {}; }
}

async function writeCredentials(credentials) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS Keychain encryption is unavailable.");
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const encrypted = safeStorage.encryptString(JSON.stringify(credentials)).toString("base64");
  await writeFile(join(app.getPath("userData"), "credentials.json"), `${JSON.stringify({ version: 1, encrypted })}\n`, { mode: 0o600 });
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}
