import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const token = "test_host_token_12345678901234567890";

test("server allowlists public assets and authenticates commissioner APIs", async (context) => {
  const port = 43_000 + Math.floor(Math.random() * 2_000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), SUN_GOD_HOST_TOKEN: token, SUN_GOD_RELAY_URL: "disabled", SUN_GOD_RELAY_ADMIN_SECRET: "disabled" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGTERM"));
  await waitForServer(child, port);

  const base = `http://127.0.0.1:${port}`;
  for (const pathname of ["/.env", "/.git/config", "/server.mjs", "/package.json", "/test/domain.test.mjs", "/src/openai-roast-service.mjs", "/%2e%2e/.env"]) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }

  const asset = await fetch(`${base}/src/app.mjs`);
  assert.equal(asset.status, 200);
  const fantasyProsAsset = await fetch(`${base}/src/fantasy-pros-data.mjs`);
  assert.equal(fantasyProsAsset.status, 200);
  assert.match(asset.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(asset.headers.get("x-content-type-options"), "nosniff");

  const denied = await fetch(`${base}/api/auctioneer/status`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${base}/api/auctioneer/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(allowed.status, 200);
  const session = await fetch(`${base}/api/host-session`, { method: "POST" });
  assert.deepEqual(await session.json(), { token });

  const relay = await fetch(`${base}/api/relay-room`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(relay.status, 503);
  assert.match((await relay.json()).error, /Personal remote bidding is not configured/);
});

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start.")), 5_000);
    child.once("exit", (code) => reject(new Error(`Server exited early with ${code}.`)));
    child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
    child.stdout.on("data", (chunk) => {
      if (!chunk.toString().includes(`localhost:${port}`)) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}
