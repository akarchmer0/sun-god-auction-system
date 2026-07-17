# Gavel

Gavel is a local-first fantasy football auction draft room with a voice auctioneer, microphone bid commands, a room-camera preview, salary-cap enforcement, rosters, and a reversible sale ledger.

## Run it

```bash
./start.command
```

The launcher uses Node from your shell when available and otherwise uses the Node runtime bundled with Codex. It also starts the included local Sherpa-ONNX speaker engine. You do not need `npm`, a Picovoice account, an API key, or a company email to run the core draft room.

Then open `http://localhost:4173` in Chrome. Camera and microphone access work on localhost after the browser grants permission.

No API key is required for the core draft room or the browser auctioneer voice. The optional live microphone listener uses OpenAI, while every auction action still has a button or keyboard fallback.

Automatic manager identification uses the included open-source Sherpa-ONNX runtime and a local speaker-embedding model. Gavel records a short clip for enrollment or a spoken bid, sends it only to its own `localhost` helper, and compares the resulting embedding to voiceprints held in the browser. Neither recordings nor voiceprints are sent to a remote service.

## OpenAI voice pipeline

Gavel replaces the browser's built-in speech recognition with OpenAI Realtime transcription (`gpt-realtime-whisper`). It streams detected speech turns to OpenAI and produces a final transcript for each utterance. A second lightweight model (`gpt-5-mini`) interprets that transcript in fantasy-auction context, so it can still correct likely text mistakes such as “bed” for “bid” or “Alex spits five” for “Alex bids five.”

1. Create an OpenAI API key in an account with API billing enabled. This does not require a company email.
2. In Terminal, create the local configuration file:

   ```bash
   cp .env.example .env
   open -e .env
   ```

3. Replace `your_openai_api_key_here` with the key, save the file, then restart Gavel with `./start.command`.
4. Open **Enroll voices**. The **OpenAI live transcription** card will show **READY**. When the microphone is on, it changes to **LISTENING**. You can separately turn the cloud bid interpreter off there at any time.

The permanent API key is read only by `server.mjs` on the Mac; it is never delivered to the browser. When the microphone is on, OpenAI receives detected microphone speech for transcription. Camera video and local voiceprints do not leave the Mac. The interpreter then receives only the final text transcript, current bid/increment/phase, and team and manager names; that Responses API request uses strict JSON output and `store: false`. Gavel pauses the countdown while it interprets a likely bid, then continues to enforce budgets, increments, roster limits, and enrolled-speaker matching locally. If bid interpretation is unavailable, Gavel falls back to the local bid parser.

## Draft flow

1. Click a player in **On deck** to nominate them.
2. Click **Start auction**.
3. Click a team to place a bid, or arm a team and say “bid.” You can also say a team/manager name and a numeric bid, such as “Alex bids 12.”
4. The automatic countdown gives the room eight seconds before “going once,” then five seconds before “going twice,” and just over four seconds before sale. Any valid bid resets it.
5. Completed sales update the team's budget and roster. **Undo last** reverses the most recent sale.

Number keys 1–9 place quick bids. Space advances the countdown manually.

## Voice check-in

1. Click **Enroll voices** in the header—there is nothing to sign up for or configure.
2. With everyone’s consent, enroll each manager one at a time by speaking naturally for six seconds until progress reaches 100%.
3. Turn on the main microphone. When someone says a bid, Gavel uses their most recent few seconds of speech to compare against the enrolled local voiceprints.
4. High-confidence bids are assigned automatically. Uncertain matches stop the countdown and ask the operator to choose the correct manager.

Voiceprints are compact biometric identifiers stored in the browser’s IndexedDB. Raw enrollment audio is discarded after the local model processes it. The dialog provides per-manager and delete-all controls. Existing Picovoice enrollments cannot be reused, so re-enroll each manager once after this update.

Gavel uses OpenAI Realtime transcription for the initial transcript and pauses it whenever the browser auctioneer speaks, so it does not transcribe itself. Speaker identification is still local. The team buttons, spoken manager name, and armed-team flow remain available if transcription is unavailable.

## Player CSV

Importing a CSV resets the draft. Required columns are `name` and `position`; optional columns are `team` and `value`.

```csv
name,position,team,value
Puka Nacua,WR,LAR,42
Bijan Robinson,RB,ATL,55
```

The included values and player board are demo data, not live rankings.

## Architecture notes

- `src/domain.mjs` is the deterministic auction engine. Voice and camera cannot mutate budgets directly.
- `src/app.mjs` contains browser device adapters and the room UI.
- `src/realtime-transcriber.mjs` captures live speech, detects utterance boundaries, and sends 24 kHz PCM to an OpenAI Realtime transcription session using a short-lived token.
- `server.mjs` mints short-lived OpenAI Realtime session tokens and interprets bid transcripts; the permanent API key remains server-side.
- `src/auction-intent.mjs` validates cloud results before the browser uses them.
- `src/voice-identity.mjs` owns local enrollment, audio capture, IndexedDB voiceprint storage, and confidence-based identity resolution.
- `speaker_worker.py` keeps the included Sherpa-ONNX model warm and returns embeddings through the local web server; it does not save recordings or profiles.
- Draft state is persisted in `localStorage`.
- The camera feed and speaker-identity voiceprints stay on the Mac. Detected microphone speech is sent to OpenAI only while live transcription is enabled.
- A production auctioneer voice provider can be added behind the `speak()` adapter.

## Test

```bash
npm test
```

The tests cover bid increments, reserve-budget rules, countdown transitions, completed sales, undo, no-bid queue rotation, strong voice matches, ambiguous speakers, and stale/low-confidence audio.
