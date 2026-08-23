import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { PhoneRoomHub } from "./src/phone-room-hub.mjs";
import { DraftStore } from "./src/draft-store.mjs";
import { CartesiaSpeechService } from "./src/cartesia-speech-service.mjs";
import { ElevenLabsSpeechService } from "./src/elevenlabs-speech-service.mjs";
import { speechProviderCandidates, speechProviderStatus } from "./src/auctioneer-speech-providers.mjs";
import { normalizeAuctioneerSpeed } from "./src/auctioneer-speed.mjs";
import { SpeechAudioCache, countdownCacheKey } from "./src/speech-cache.mjs";
import { OpenAIRoastService } from "./src/openai-roast-service.mjs";
import { OpenAIPatterService } from "./src/openai-patter-service.mjs";
import { OpenAIAutodraftService } from "./src/openai-autodraft-service.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
loadLocalEnv(root);
const port = Number(process.env.PORT || 4173);
const hostToken = process.env.SUN_GOD_HOST_TOKEN || randomBytes(32).toString("base64url");
const dataDirectory = process.env.SUN_GOD_DATA_DIR || join(homedir(), "Library", "Application Support", "Sun God Auctioneer");
const cartesiaSpeech = new CartesiaSpeechService({
  apiKey: process.env.CARTESIA_API_KEY,
  voiceId: process.env.CARTESIA_VOICE_ID,
  model: process.env.CARTESIA_MODEL
});
const elevenLabsSpeech = new ElevenLabsSpeechService({
  apiKey: process.env.ELEVENLABS_API_KEY,
  voiceId: process.env.ELEVENLABS_VOICE_ID,
  model: process.env.ELEVENLABS_MODEL
});
const speechProviders = { elevenlabs: elevenLabsSpeech, cartesia: cartesiaSpeech };
const roastWriter = new OpenAIRoastService({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_ROAST_MODEL
});
const patterDirector = new OpenAIPatterService({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_PATTER_MODEL
});
const autodraftDirector = new OpenAIAutodraftService({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_AUTODRAFT_MODEL
});
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml"
};
const publicAssets = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/bidder.html", "bidder.html"],
  ["/results.html", "results.html"],
  ...[
    "app.mjs", "bidder.mjs", "results.mjs", "styles.css", "bidder.css", "results.css",
    "data.mjs", "fantasy-pros-data.mjs", "auctioneer-voice.mjs", "auctioneer-speech-providers.mjs", "auctioneer-speed.mjs",
    "auctioneer-script.mjs", "auctioneer-patter.mjs", "roast-engine.mjs",
    "phone-bidding.mjs", "draft-io.mjs", "vision-bidding.mjs", "domain.mjs", "autodraft.mjs"
    , "room-protocol.mjs", "room-transports.mjs", "remote-speech-relay.mjs", "draft-state-validation.mjs", "yahoo-market-values.mjs"
  ].map((name) => [`/src/${name}`, `src/${name}`]),
  ["/vendor/qrcodegen.js", "vendor/qrcodegen.js"]
  , ["/assets/player-template.csv", "assets/player-template.csv"]
  , ["/assets/yahoo-market-values.json", "data/yahoo-market-values.json"]
]);
const hostOnlyRoutes = new Set([
  "/api/auctioneer/status", "/api/auctioneer/speech", "/api/auctioneer/roast",
  "/api/auctioneer/patter", "/api/autodraft/intent", "/api/phone-room/upsert",
  "/api/phone-room/reset-claims", "/api/phone-room/state", "/api/draft-state",
  "/api/draft-backup", "/api/draft-backup/import", "/api/relay-room"
]);
const rateLimits = new Map();

const phoneRoomHub = new PhoneRoomHub();
const speechAudioCache = new SpeechAudioCache();
const draftStore = new DraftStore({ directory: dataDirectory });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    applySecurityHeaders(response);
    if (url.pathname === "/api/host-session") {
      if (request.method !== "POST") return send(response, 405, "Method not allowed");
      if (!isLoopback(request.socket.remoteAddress)) throw apiError("Host access is available only on this Mac.", 403);
      return sendJson(response, 200, { token: hostToken });
    }
    if (hostOnlyRoutes.has(url.pathname)) requireHostAuthorization(request);
    enforceRateLimit(request, url.pathname);
    if (request.method === "POST" && url.pathname === "/api/relay-room") return sendJson(response, 201, await createRelayRoom());
    if (request.method === "GET" && url.pathname === "/api/draft-state") {
      return sendJson(response, 200, await draftStore.load());
    }
    if (request.method === "PUT" && url.pathname === "/api/draft-state") {
      const payload = await readJsonRequest(request, 2_000_000);
      return sendJson(response, 200, await draftStore.save(payload?.state, { expectedRevision: payload?.expectedRevision }));
    }
    if (request.method === "GET" && url.pathname === "/api/draft-backup") {
      const backup = await draftStore.load();
      if (!backup.state) throw apiError("There is no saved draft to export.", 404);
      response.setHeader("Content-Disposition", `attachment; filename=\"sun-god-draft-${backup.revision}.json\"`);
      return sendJson(response, 200, backup);
    }
    if (request.method === "POST" && url.pathname === "/api/draft-backup/import") {
      return sendJson(response, 200, await draftStore.importBackup(await readJsonRequest(request, 2_500_000)));
    }
    if (request.method === "GET" && url.pathname === "/api/auctioneer/status") {
      const providers = Object.fromEntries(Object.entries(speechProviders).map(([id, service]) => [id, service.status()]));
      return sendJson(response, 200, {
        ...speechProviderStatus("auto", providers),
        providers,
        countdownCacheEntries: speechAudioCache.size,
        roasting: roastWriter.status(),
        patter: patterDirector.status(),
        autodraft: autodraftDirector.status()
      });
    }
    if (request.method === "POST" && url.pathname === "/api/auctioneer/speech") {
      return await streamAuctioneerSpeech(request, response);
    }
    if (request.method === "POST" && url.pathname === "/api/auctioneer/roast") {
      const payload = await readJsonRequest(request);
      const roast = await roastWriter.createRoast({
        context: payload?.context,
        recentRoasts: payload?.recentRoasts,
        personality: ["classic", "hype", "pro"].includes(payload?.personality) ? payload.personality : "classic"
      });
      return sendJson(response, 200, roast);
    }
    if (request.method === "POST" && url.pathname === "/api/auctioneer/patter") {
      const payload = await readJsonRequest(request);
      const patter = await patterDirector.createPatter({
        context: payload?.context,
        recentLines: payload?.recentLines,
        personality: ["classic", "hype", "pro"].includes(payload?.personality) ? payload.personality : "classic",
        energy: Math.min(3, Math.max(1, Number(payload?.energy) || 2))
      });
      return sendJson(response, 200, patter);
    }
    if (request.method === "POST" && url.pathname === "/api/autodraft/intent") {
      const payload = await readJsonRequest(request);
      const result = await autodraftDirector.createIntents({
        context: payload?.context,
        fallbackDecisions: payload?.fallbackDecisions
      });
      return sendJson(response, 200, result);
    }
    if (request.method === "GET" && url.pathname === "/api/phone-room") {
      const room = phoneRoomHub.snapshot(url.searchParams.get("room"));
      return sendJson(response, 200, withJoinUrls(request, room));
    }
    if (request.method === "GET" && url.pathname === "/api/phone-room/events") {
      return openPhoneRoomEvents(request, response, url.searchParams.get("room"));
    }
    if (request.method === "POST" && url.pathname === "/api/phone-room/upsert") {
      const payload = await readJsonRequest(request);
      const room = phoneRoomHub.upsertRoom(payload);
      return sendJson(response, 200, withJoinUrls(request, room));
    }
    if (request.method === "POST" && url.pathname === "/api/phone-room/claim") {
      return sendJson(response, 200, phoneRoomHub.claimTeam(await readJsonRequest(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/phone-room/release") {
      return sendJson(response, 200, phoneRoomHub.releaseTeam(await readJsonRequest(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/phone-room/reset-claims") {
      return sendJson(response, 200, phoneRoomHub.resetClaims(await readJsonRequest(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/phone-room/state") {
      return sendJson(response, 200, phoneRoomHub.updateAuction(await readJsonRequest(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/phone-room/bid") {
      return sendJson(response, 202, phoneRoomHub.placeBid(await readJsonRequest(request)));
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, "Method not allowed");
    await serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    const message = cleanError(error);
    const status = error?.status || 500;
    sendJson(response, status, { error: message });
  }
});

server.listen(port, "::", () => {
  console.log(`Sun God Auction Systems is running at http://localhost:${port}`);
  for (const [name, service] of Object.entries(speechProviders)) {
    if (service.status().available) {
      service.warm()
        .then(() => console.log(`${name === "elevenlabs" ? "ElevenLabs" : "Cartesia"} auctioneer is ready (${service.model}).`))
        .catch((error) => console.warn(`[${name}] ${cleanError(error)}`));
    }
  }
  if (!Object.values(speechProviders).some((service) => service.status().available)) console.log("No realtime auctioneer is configured; browser voice fallback is active.");
});

async function serveStatic(pathname, response, isHead) {
  const relative = publicAssets.get(pathname);
  if (!relative) return send(response, 404, "Not found");
  const filePath = resolve(root, relative);
  let body;
  try { body = isHead ? null : await readFile(filePath); }
  catch (error) { if (error?.code === "ENOENT") return send(response, 404, "Not found"); throw error; }
  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    ...(isHead ? {} : { "Content-Length": body.length })
  });
  response.end(body || undefined);
}

function applySecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function requireHostAuthorization(request) {
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expected = Buffer.from(hostToken);
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw apiError("A valid commissioner session is required.", 401);
  }
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || String(address || "").startsWith("::ffff:127.");
}

function enforceRateLimit(request, pathname) {
  if (!pathname.startsWith("/api/") || hostOnlyRoutes.has(pathname) || pathname === "/api/host-session") return;
  const now = Date.now();
  const windowMs = 60_000;
  const limit = pathname.endsWith("/bid") ? 120 : pathname.endsWith("/events") ? 30 : 60;
  const key = `${request.socket.remoteAddress || "unknown"}:${pathname}`;
  const record = rateLimits.get(key);
  if (!record || now - record.startedAt >= windowMs) {
    rateLimits.set(key, { startedAt: now, count: 1 });
    return;
  }
  record.count += 1;
  if (record.count > limit) throw apiError("Too many requests. Wait a moment and try again.", 429);
  if (rateLimits.size > 2_000) {
    for (const [entryKey, entry] of rateLimits) if (now - entry.startedAt >= windowMs) rateLimits.delete(entryKey);
  }
}

async function createRelayRoom() {
  const relayUrl = String(process.env.SUN_GOD_RELAY_URL || "").replace(/\/$/, "");
  const adminSecret = String(process.env.SUN_GOD_RELAY_ADMIN_SECRET || "").trim();
  if (!/^https:\/\//i.test(relayUrl) || adminSecret.length < 24) {
    throw apiError("Personal remote bidding is not configured. Add SUN_GOD_RELAY_URL and a long SUN_GOD_RELAY_ADMIN_SECRET, then restart Sun God.", 503);
  }
  const response = await fetch(`${relayUrl}/v1/rooms`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${adminSecret}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(payload.error || "The remote bidding relay could not create a room.", response.status);
  return { ...payload, relayUrl };
}

function readRequestBody(request, maxBytes = 80_000) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(apiError("The request body is too large.", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJsonRequest(request, maxBytes) {
  const body = await readRequestBody(request, maxBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw apiError("The request was not valid JSON.", 400);
  }
}

async function streamAuctioneerSpeech(request, response) {
  const payload = await readJsonRequest(request);
  const requestedProvider = ["auto", "elevenlabs", "cartesia"].includes(payload?.provider) ? payload.provider : "auto";
  const speechCandidates = speechProviderCandidates(requestedProvider, speechProviders);
  if (!speechCandidates.length) {
    const statuses = Object.fromEntries(Object.entries(speechProviders).map(([id, service]) => [id, service.status()]));
    throw apiError(speechProviderStatus(requestedProvider, statuses).message, 503);
  }
  const text = String(payload?.text || "").trim().slice(0, 1_500);
  const style = String(payload?.style || "neutral").trim().slice(0, 30);
  const personality = ["classic", "hype", "pro"].includes(payload?.personality) ? payload.personality : "classic";
  const energy = Math.min(3, Math.max(1, Number(payload?.energy) || 2));
  const speed = normalizeAuctioneerSpeed(payload?.speed);
  if (!text) throw apiError("Auctioneer speech text is required.", 400);

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  for (const candidate of speechCandidates) {
    const candidateCacheKey = speechCacheKey(candidate, { text, style, personality, energy, speed });
    const cached = candidateCacheKey ? speechAudioCache.get(candidateCacheKey) : null;
    if (cached) {
      response.write(`${JSON.stringify({ type: "start", provider: candidate.status().provider, sampleRate: cached.sampleRate, encoding: "pcm_s16le", cached: true })}\n`);
      for (const event of cached.events) response.write(`${JSON.stringify(event)}\n`);
      response.write(`${JSON.stringify({ type: "done", cached: true })}\n`);
      response.end();
      return;
    }
  }

  let completed = false;
  let cancelled = false;
  let speech;
  const cancel = () => {
    if (!completed) { cancelled = true; speech?.cancel(); }
  };
  request.once("aborted", cancel);
  response.once("close", cancel);

  try {
    let lastError;
    for (const [candidateIndex, candidate] of speechCandidates.entries()) {
      const audioEvents = [];
      let started = false;
      try {
        speech = await candidate.createSpeech({
          transcript: text,
          style,
          personality,
          energy,
          speed,
          onEvent: (event) => {
            if (event.type === "audio" && event.data) {
              audioEvents.push({ type: "audio", data: event.data });
              if (!started && !response.destroyed && !response.writableEnded) {
                started = true;
                response.write(`${JSON.stringify({
                  type: "start",
                  provider: candidate.status().provider,
                  fallbackFrom: candidateIndex > 0 ? speechCandidates[0].status().provider : null,
                  sampleRate: candidate.sampleRate,
                  encoding: "pcm_s16le"
                })}\n`);
              }
            }
            if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
          }
        });
        await speech.done;
        if (cancelled) return;
        if (!audioEvents.length) throw apiError(`${candidate.status().provider} returned no audio.`, 503);
        completed = true;
        const cacheKey = speechCacheKey(candidate, { text, style, personality, energy, speed });
        if (cacheKey) speechAudioCache.set(cacheKey, { sampleRate: speech.sampleRate, events: audioEvents });
        if (!response.destroyed && !response.writableEnded) {
          response.write(`${JSON.stringify({ type: "done" })}\n`);
          response.end();
        }
        return;
      } catch (error) {
        lastError = error;
        if (cancelled) return;
        if (started || requestedProvider !== "auto") throw error;
      }
    }
    throw lastError || apiError("No realtime voice provider could start speech.", 503);
  } catch (error) {
    completed = true;
    if (!response.destroyed && !response.writableEnded) {
      response.write(`${JSON.stringify({ type: "error", message: cleanError(error) })}\n`);
      response.end();
    }
  } finally {
    request.off("aborted", cancel);
    response.off("close", cancel);
  }
}

function speechCacheKey(service, performance) {
  return countdownCacheKey({
    ...performance,
    voiceId: service.voiceId,
    model: `${service.status().provider}:${service.model}`
  });
}

function openPhoneRoomEvents(request, response, roomId) {
  phoneRoomHub.requireRoom(roomId);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.write(": Sun God phone room\n\n");
  const unsubscribe = phoneRoomHub.subscribe(roomId, (event) => {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 20_000);
  const close = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  request.once("close", close);
  response.once("close", close);
}

function withJoinUrls(request, room) {
  const encodedRoom = encodeURIComponent(room.roomId);
  const hostHeader = String(request.headers.host || `localhost:${port}`);
  const requestedHostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0];
  const safeRequestedHostname = /^[A-Za-z0-9.:-]+$/.test(requestedHostname) ? requestedHostname : "localhost";
  const addresses = [
    ...lanAddresses(),
    ...(!["localhost", "127.0.0.1", "::1"].includes(safeRequestedHostname) ? [safeRequestedHostname] : [])
  ];
  const uniqueAddresses = [...new Set(addresses)];
  const joinUrls = (uniqueAddresses.length ? uniqueAddresses : ["localhost"])
    .map((address) => `http://${address.includes(":") ? `[${address}]` : address}:${port}/bidder.html?room=${encodedRoom}`);
  return { ...room, joinUrl: joinUrls[0], joinUrls };
}

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const address of entries || []) {
      const isIpv4 = address.family === "IPv4" || address.family === 4;
      if (isIpv4 && !address.internal) addresses.push(address.address);
    }
  }
  return addresses.sort((left, right) => privateAddressRank(left) - privateAddressRank(right));
}

function privateAddressRank(address) {
  if (/^192\.168\./.test(address)) return 0;
  if (/^10\./.test(address)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function loadLocalEnv(directory) {
  const envPath = resolve(directory, ".env");
  let source = "";
  try { source = readFileSync(envPath, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") console.warn("Could not read Sun God's .env file."); return; }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(SUN_GOD_RELAY_URL|SUN_GOD_RELAY_ADMIN_SECRET|CARTESIA_API_KEY|CARTESIA_VOICE_ID|CARTESIA_MODEL|ELEVENLABS_API_KEY|OPENAI_AUTODRAFT_MODEL|ELEVENLABS_VOICE_ID|ELEVENLABS_MODEL|OPENAI_API_KEY|OPENAI_ROAST_MODEL|OPENAI_PATTER_MODEL)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").trim();
    if (value) process.env[match[1]] = value;
  }
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function send(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

function cleanError(error) {
  return (error?.message || String(error || "Unknown error")).replace(/^Error:\s*/i, "");
}

let isShuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    cartesiaSpeech.close();
    elevenLabsSpeech.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  });
}
