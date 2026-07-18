import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { PhoneRoomHub } from "./src/phone-room-hub.mjs";
import { CartesiaSpeechService } from "./src/cartesia-speech-service.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
loadLocalEnv(root);
const port = Number(process.env.PORT || 4173);
const cartesiaSpeech = new CartesiaSpeechService({
  apiKey: process.env.CARTESIA_API_KEY,
  voiceId: process.env.CARTESIA_VOICE_ID,
  model: process.env.CARTESIA_MODEL
});
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

const phoneRoomHub = new PhoneRoomHub();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/auctioneer/status") {
      return sendJson(response, 200, cartesiaSpeech.status());
    }
    if (request.method === "POST" && url.pathname === "/api/auctioneer/speech") {
      return await streamAuctioneerSpeech(request, response);
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
  if (cartesiaSpeech.status().available) {
    cartesiaSpeech.warm()
      .then(() => console.log(`Cartesia auctioneer is ready (${cartesiaSpeech.model}).`))
      .catch((error) => console.warn(`[Cartesia] ${cleanError(error)}`));
  } else {
    console.log("Cartesia auctioneer is not configured; browser voice fallback is active.");
  }
});

async function serveStatic(pathname, response, isHead) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return send(response, 403, "Forbidden");
  try {
    if (!(await stat(filePath)).isFile()) return send(response, 404, "Not found");
  } catch (error) {
    if (error?.code === "ENOENT") return send(response, 404, "Not found");
    throw error;
  }
  const body = isHead ? null : await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Content-Length": body?.length,
    "Cache-Control": "no-cache"
  });
  response.end(body || undefined);
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

async function readJsonRequest(request) {
  const body = await readRequestBody(request);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw apiError("The request was not valid JSON.", 400);
  }
}

async function streamAuctioneerSpeech(request, response) {
  if (!cartesiaSpeech.status().available) throw apiError(cartesiaSpeech.status().message, 503);
  const payload = await readJsonRequest(request);
  const text = String(payload?.text || "").trim().slice(0, 1_500);
  const style = String(payload?.style || "neutral").trim().slice(0, 30);
  if (!text) throw apiError("Auctioneer speech text is required.", 400);

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  let completed = false;
  let speech;
  const cancel = () => {
    if (!completed) speech?.cancel();
  };
  request.once("aborted", cancel);
  response.once("close", cancel);

  try {
    speech = await cartesiaSpeech.createSpeech({
      transcript: text,
      style,
      onEvent: (event) => {
        if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
      }
    });
    response.write(`${JSON.stringify({ type: "start", contextId: speech.contextId, sampleRate: speech.sampleRate, encoding: "pcm_s16le" })}\n`);
    await speech.done;
    completed = true;
    if (!response.destroyed && !response.writableEnded) {
      response.write(`${JSON.stringify({ type: "done" })}\n`);
      response.end();
    }
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
  const addresses = [
    ...lanAddresses(),
    ...(!["localhost", "127.0.0.1", "::1"].includes(requestedHostname) ? [requestedHostname] : [])
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
    const match = line.match(/^\s*(?:export\s+)?(CARTESIA_API_KEY|CARTESIA_VOICE_ID|CARTESIA_MODEL)\s*=\s*(.*?)\s*$/);
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  });
}
