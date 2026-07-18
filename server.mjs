import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
loadLocalEnv(root);
const port = Number(process.env.PORT || 4173);
const python = process.env.GAVEL_PYTHON || "/usr/bin/python3";
const runtimePath = resolve(root, ".runtime/python");
const openAiApiKey = String(process.env.OPENAI_API_KEY || "").trim();
const auctionIntentModel = String(process.env.GAVEL_INTENT_MODEL || "gpt-5-mini").trim() || "gpt-5-mini";
const transcriptionModel = String(process.env.GAVEL_TRANSCRIPTION_MODEL || "gpt-realtime-whisper").trim() || "gpt-realtime-whisper";
const safetyIdentifier = createHash("sha256").update(`${process.env.USER || "gavel"}:${root}`).digest("hex");
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

const speakerWorker = createSpeakerWorker();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "POST" && url.pathname === "/api/voice/embed") {
      const samples = await readRequestBody(request);
      const sampleRate = Number(request.headers["x-gavel-sample-rate"] || 16000);
      const embedding = await speakerWorker.embed(samples, sampleRate);
      return sendJson(response, 200, { embedding });
    }
    if (request.method === "GET" && url.pathname === "/api/voice/status") {
      return sendJson(response, speakerWorker.ready ? 200 : 503, speakerWorker.status());
    }
    if (request.method === "GET" && url.pathname === "/api/auction/interpret/status") {
      return sendJson(response, 200, cloudInterpreterStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/auction/interpret") {
      const payload = await readJsonRequest(request);
      const interpretation = await interpretAuctionSpeech(payload);
      return sendJson(response, 200, interpretation);
    }
    if (request.method === "GET" && url.pathname === "/api/transcription/status") {
      return sendJson(response, 200, transcriptionStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/transcription/session") {
      return sendJson(response, 200, await createRealtimeTranscriptionSession());
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, "Method not allowed");
    await serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    const message = cleanError(error);
    const status = error?.status || (/Speaker recognition is starting|unavailable|clip was too short|Keep speaking|Unsupported microphone sample rate/i.test(message) ? 503 : 500);
    sendJson(response, status, { error: message });
  }
});

server.listen(port, "::", () => {
  console.log(`Sun God Auction Systems is running at http://localhost:${port}`);
});

function createSpeakerWorker() {
  const pending = new Map();
  let sequence = 0;
  let state = "starting";
  let startupError = null;
  const child = spawn(python, ["speaker_worker.py"], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: [runtimePath, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stdout = createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === "ready") {
      state = "ready";
      console.log(`Local speaker recognition is ready (${message.dimension}-dimension embeddings).`);
      return;
    }
    if (message.type === "startup-error") {
      state = "error";
      startupError = message.error || "The local speaker-recognition worker could not start.";
      console.error(startupError);
      return;
    }
    const resolver = pending.get(message.id);
    if (!resolver) return;
    pending.delete(message.id);
    clearTimeout(resolver.timer);
    if (message.error) resolver.reject(new Error(message.error));
    else resolver.resolve(message.embedding);
  });
  child.stderr.on("data", (data) => console.error(`[speaker worker] ${data.toString().trim()}`));
  child.on("error", (error) => failWorker(error.message));
  child.on("exit", (code) => {
    if (state !== "error") failWorker(`The local speaker-recognition worker stopped (exit ${code ?? "unknown"}).`);
  });

  function failWorker(error) {
    state = "error";
    startupError = error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(error));
    }
    pending.clear();
  }

  return {
    get ready() { return state === "ready"; },
    status() { return { status: state, error: startupError }; },
    embed(samples, sampleRate) {
      if (state === "starting") throw new Error("Speaker recognition is starting. Try again in a moment.");
      if (state !== "ready") throw new Error(startupError || "Speaker recognition is unavailable.");
      const id = `voice-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Speaker recognition took too long. Please try the bid again."));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, sampleRate, pcmBase64: samples.toString("base64") })}\n`);
      });
    },
    stop() {
      if (!child.killed) child.kill();
    }
  };
}

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

function readRequestBody(request, maxBytes = 2_500_000) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Audio clip is too large. Please try again."));
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
  const body = await readRequestBody(request, 80_000);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw apiError("The cloud interpreter request was not valid JSON.", 400);
  }
}

function cloudInterpreterStatus() {
  return {
    available: Boolean(openAiApiKey),
    model: openAiApiKey ? auctionIntentModel : null,
    message: openAiApiKey
      ? "Cloud bid interpretation is ready."
      : "Add OPENAI_API_KEY to .env, then restart Sun God to enable cloud bid interpretation."
  };
}

function transcriptionStatus() {
  return {
    available: Boolean(openAiApiKey),
    model: openAiApiKey ? transcriptionModel : null,
    message: openAiApiKey
      ? "OpenAI live transcription is ready."
      : "Add OPENAI_API_KEY to .env, then restart Sun God to enable OpenAI live transcription."
  };
}

async function createRealtimeTranscriptionSession() {
  if (!openAiApiKey) throw apiError("OpenAI live transcription is not configured. Add OPENAI_API_KEY to .env, then restart Sun God.", 503);
  const session = {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: transcriptionModel, language: "en", delay: "high" },
        turn_detection: null
      }
    }
  };
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": safetyIdentifier
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.value) {
      if (response.status === 401) throw apiError("OpenAI could not authenticate the API key. Check OPENAI_API_KEY and restart Sun God.", 503);
      if (response.status === 429) throw apiError("OpenAI is temporarily rate-limiting live transcription. Try turning the mic on again in a moment.", 503);
      throw apiError("OpenAI could not start a live transcription session. Check that your API project can use Realtime transcription.", 503);
    }
    return { value: payload.value, expiresAt: payload.expires_at || null, model: transcriptionModel };
  } catch (error) {
    if (error?.status) throw error;
    throw apiError("OpenAI live transcription is unavailable. Check your network, then try the mic again.", 503);
  }
}

async function interpretAuctionSpeech(payload) {
  if (!openAiApiKey) throw apiError("Cloud bid interpretation is not configured. Add OPENAI_API_KEY to .env, then restart Sun God.", 503);
  const transcript = String(payload?.transcript || "").trim().slice(0, 700);
  if (!transcript) throw apiError("A spoken transcript is required.", 400);

  const teams = Array.isArray(payload?.teams)
    ? payload.teams.slice(0, 20).map((team) => ({
      id: String(team?.id || "").trim().slice(0, 80),
      name: String(team?.name || "").trim().slice(0, 100),
      manager: String(team?.manager || "").trim().slice(0, 100)
    })).filter((team) => team.id && (team.name || team.manager))
    : [];
  if (!teams.length) throw apiError("At least one auction manager is required.", 400);

  const currentBid = boundedInteger(payload?.auction?.currentBid, 0, 1_000);
  const increment = boundedInteger(payload?.auction?.increment, 1, 100);
  const phase = String(payload?.auction?.phase || "").slice(0, 30);
  const response = await requestOpenAiIntent({ transcript, teams, currentBid, increment, phase });
  const text = extractResponseText(response);
  if (!text) throw apiError("The cloud interpreter returned no usable result.", 502);
  try {
    return JSON.parse(text);
  } catch {
    throw apiError("The cloud interpreter returned an invalid result.", 502);
  }
}

async function requestOpenAiIntent({ transcript, teams, currentBid, increment, phase }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  const managerIds = teams.map((team) => team.id);
  const requestBody = {
    model: auctionIntentModel,
    store: false,
    instructions: [
      "You are the bid-intent interpreter for a live fantasy football auction.",
      "Interpret a single imperfect speech-to-text transcript. It may contain phonetic transcription mistakes: for example, 'bed' can mean 'bid' and 'Alex spits five' can mean 'Alex bids five'.",
      "Return intent='bid' only when the speaker likely intends to make an auction bid. Return intent='ignore' for room chatter, an unclear phrase, or a phrase that is not a bid.",
      "Use only a manager_id from the provided manager list; otherwise return null. Do not invent a bid amount. If a person says only 'bid', set amount to null rather than guessing the next legal bid.",
      "The local app enforces all auction rules and identifies enrolled voices. Your result is a best-effort interpretation, not an authorization."
    ].join(" "),
    input: JSON.stringify({
      transcript,
      auction: { current_bid: currentBid, bid_increment: increment, phase },
      managers: teams
    }),
    text: {
      format: {
        type: "json_schema",
        name: "auction_bid_intent",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: { type: "string", enum: ["bid", "ignore"] },
            amount: {
              anyOf: [
                { type: "integer", minimum: 1, maximum: 1000 },
                { type: "null" }
              ]
            },
            manager_id: {
              anyOf: [
                { type: "string", enum: managerIds },
                { type: "null" }
              ]
            },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          },
          required: ["intent", "amount", "manager_id", "confidence"]
        }
      }
    }
  };

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) throw apiError("OpenAI could not authenticate the API key. Check OPENAI_API_KEY and restart Sun God.", 503);
      if (response.status === 429) throw apiError("OpenAI is temporarily rate-limiting bid interpretation. Sun God will keep using its local bid parser.", 503);
      throw apiError("OpenAI could not interpret that bid right now. Sun God will keep using its local bid parser.", 503);
    }
    return payload;
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "AbortError") throw apiError("Cloud bid interpretation took too long. Sun God will keep using its local bid parser.", 503);
    throw apiError("Cloud bid interpretation is unavailable. Sun God will keep using its local bid parser.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function extractResponseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    const text = item.content?.find((content) => content?.type === "output_text")?.text;
    if (typeof text === "string") return text;
  }
  return "";
}

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : fallback;
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
    const match = line.match(/^\s*(?:export\s+)?(OPENAI_API_KEY|GAVEL_INTENT_MODEL|GAVEL_TRANSCRIPTION_MODEL)\s*=\s*(.*?)\s*$/);
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
    speakerWorker.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  });
}
