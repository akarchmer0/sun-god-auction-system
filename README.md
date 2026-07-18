# Sun God Auction Systems

Sun God Auction Systems is a local-first fantasy football auction draft room with a reactive Cartesia AI auctioneer, zero-install phone bidding, salary-cap enforcement, live rosters, and a reversible sale ledger.

## Run it

```bash
./start.command
```

The launcher uses Node from your shell when available and otherwise uses the Node runtime bundled with Codex. It also starts the included local Sherpa-ONNX speaker engine. You do not need `npm`, a Picovoice account, an API key, or a company email to run the core draft room.

Then open `http://localhost:4173` in Chrome. Keep the laptop and bidder phones on the same Wi-Fi network. Microphone access works on localhost after the browser grants permission.

No API key is required for the core draft room. Cartesia powers the upgraded realtime auctioneer when configured and automatically falls back to the browser voice otherwise. The optional live microphone listener uses OpenAI, while every auction action still has a button or keyboard fallback.

## Cartesia AI auctioneer

Sun God keeps a Cartesia WebSocket warm on the Mac and streams raw audio to the host browser. Every announcement has its own speech context. A valid phone bid immediately stops the currently scheduled audio and begins a fresh, energetic bid acknowledgement; countdowns, rulings, nominations, and sales each use different pacing and emotional direction.

1. Create a Cartesia API key at `https://play.cartesia.ai/keys`.
2. If you have not already created local configuration, run:

   ```bash
   cp .env.example .env
   open -e .env
   ```

3. Put the key after `CARTESIA_API_KEY=` and restart with `./start.command`.
4. Open **Enroll voices** to see the **AI auctioneer voice** status. It should say **CARTESIA READY**.

The permanent Cartesia key stays in the Mac's local `.env` file and is read only by `server.mjs`. The browser receives only generated PCM audio. The default is Cartesia's British Lucy voice on `sonic-3.5`; set `CARTESIA_VOICE_ID` in `.env` to any voice ID from the Cartesia playground to change it. If Cartesia is unconfigured or temporarily unavailable, Sun God automatically uses the operating system's browser voice so the draft can continue.

Automatic manager identification uses the included open-source Sherpa-ONNX runtime and a local speaker-embedding model. Sun God records a short clip for enrollment or a spoken bid, sends it only to its own `localhost` helper, and compares the resulting embedding to voiceprints held in the browser. Neither recordings nor voiceprints are sent to a remote service.

## Phone bidding

The laptop creates a private room code and a join link using its local network address. No participant app or account is required.

1. Finish the team order in **League setup**.
2. Each participant scans the QR code in the **Phone bidding** panel.
3. The participant chooses their manager. Sun God prevents another phone from claiming the same team.
4. During an auction, the phone's **Auction** tab shows the player, current bid, budget, maximum legal bid, and roster count. Managers can tap the large next-dollar **Bid** button, choose one of two round-number **Easy bids** interpolated toward the player's suggested value, or enter any legal whole-dollar amount. The **Roster** tab lists every purchased player and price.
5. The laptop receives the bid, enforces the increment and budget, announces it, and updates every phone.

Bid requests are timestamped when the Sun God server receives them. Within the same 300 ms window, the highest submitted amount wins; if multiple managers submit that same highest amount, the auction pauses and displays those managers so the laptop operator can make a ruling without silently choosing based on network order.

The QR code is generated locally. Phone requests stay between the participant devices and the Mac running Sun God. If a phone cannot open the join page, confirm both devices are on the same non-guest Wi-Fi network, disconnect any VPN, and allow incoming network connections if macOS asks.

## OpenAI voice pipeline

Sun God replaces the browser's built-in speech recognition with OpenAI Realtime transcription (`gpt-realtime-whisper`). It streams detected speech turns to OpenAI and produces a final transcript for each utterance. A second lightweight model (`gpt-5-mini`) interprets that transcript in fantasy-auction context, so it can still correct likely text mistakes such as “bed” for “bid” or “Alex spits five” for “Alex bids five.”

1. Create an OpenAI API key in an account with API billing enabled. This does not require a company email.
2. In Terminal, create the local configuration file:

   ```bash
   cp .env.example .env
   open -e .env
   ```

3. Replace `your_openai_api_key_here` with the key, save the file, then restart Sun God with `./start.command`.
4. Open **Enroll voices**. The **OpenAI live transcription** card will show **READY**. When the microphone is on, it changes to **LISTENING**. You can separately turn the cloud bid interpreter off there at any time.

The permanent OpenAI API key is read only by `server.mjs` on the Mac; it is never delivered to the browser. When the microphone is on, OpenAI receives detected microphone speech for transcription. Local voiceprints do not leave the Mac. The interpreter then receives only the final text transcript, current bid/increment/phase, and team and manager names; that Responses API request uses strict JSON output and `store: false`. Sun God pauses the countdown while it interprets a likely bid, then continues to enforce budgets, increments, roster limits, and enrolled-speaker matching locally. If bid interpretation is unavailable, Sun God falls back to the local bid parser.

## Draft flow

1. Click a player in **On deck** to nominate them.
2. Click **Start auction**.
3. Participants tap **Bid** on their phones. The laptop team buttons, number keys, and optional spoken bids remain available to the operator.
4. The automatic countdown gives the room eight seconds before “going once,” then five seconds before “going twice,” and just over four seconds before sale. Any valid bid resets it.
5. Completed sales update the team's budget and roster. **Undo last** reverses the most recent sale.

Number keys 1–9 place quick bids. Space advances the countdown manually.

## Voice check-in

1. Click **Enroll voices** in the header—there is nothing to sign up for or configure.
2. With everyone’s consent, enroll each manager one at a time by speaking naturally for six seconds until progress reaches 100%.
3. Turn on the main microphone. When someone says a bid, Sun God uses their most recent few seconds of speech to compare against the enrolled local voiceprints.
4. High-confidence bids are assigned automatically. Uncertain matches stop the countdown and ask the operator to choose the correct manager.

Voiceprints are compact biometric identifiers stored in the browser’s IndexedDB. Raw enrollment audio is discarded after the local model processes it. The dialog provides per-manager and delete-all controls. Existing Picovoice enrollments cannot be reused, so re-enroll each manager once after this update.

Sun God uses OpenAI Realtime transcription for the initial transcript and pauses it whenever the browser auctioneer speaks, so it does not transcribe itself. Speaker identification is still local. The team buttons, spoken manager name, and armed-team flow remain available if transcription is unavailable.

## Player CSV

Importing a CSV resets the draft. Required columns are `name` and `position`; optional columns are `team` and `value`.

```csv
name,position,team,value
Puka Nacua,WR,LAR,42
Bijan Robinson,RB,ATL,55
```

The included values and player board are demo data, not live rankings.

## Architecture notes

- `src/domain.mjs` is the deterministic auction engine. Phones and voice inputs cannot mutate budgets directly.
- `src/app.mjs` coordinates the host room, phone/voice bid decisions, auctioneer direction, and the auction UI.
- `src/auctioneer-script.mjs` rotates natural nomination, bid, countdown, sale, and ruling lines without changing auction state.
- `src/auctioneer-voice.mjs` streams Cartesia PCM into an interruptible Web Audio queue and owns browser-voice fallback.
- `src/cartesia-speech-service.mjs` keeps the authenticated Cartesia WebSocket warm, applies per-event performance direction, and multiplexes speech contexts without exposing the API key.
- `src/bidder.mjs` renders the zero-install participant experience and submits authenticated team bids.
- `src/phone-bidding.mjs` calculates round-number easy bids and resolves simultaneous jump bids by amount.
- `src/phone-room-hub.mjs` owns room codes, exclusive team claims, server timestamps, live state, and participant events.
- `src/vision-bidding.mjs` supplies the shared 300 ms simultaneous-bid classification used by the host.
- `src/realtime-transcriber.mjs` captures live speech, detects utterance boundaries, and sends 24 kHz PCM to an OpenAI Realtime transcription session using a short-lived token.
- `server.mjs` serves the host and phone pages, broadcasts local room events, relays Cartesia speech, mints short-lived OpenAI Realtime session tokens, and interprets bid transcripts; permanent API keys remain server-side.
- `src/auction-intent.mjs` validates cloud results before the browser uses them.
- `src/voice-identity.mjs` owns local enrollment, audio capture, IndexedDB voiceprint storage, and confidence-based identity resolution.
- `speaker_worker.py` keeps the included Sherpa-ONNX model warm and returns embeddings through the local web server; it does not save recordings or profiles.
- Draft state is persisted in `localStorage`.
- Phone-room traffic stays on the local network. Speaker-identity voiceprints stay on the Mac. Detected microphone speech is sent to OpenAI only while live transcription is enabled.
- Cartesia is the production auctioneer voice provider; the browser speech engine remains an automatic fallback.

## Test

```bash
node --test
```

The tests cover bid increments, reserve-budget rules, countdown transitions, completed sales, undo, no-bid queue rotation, phone-room claims/state/server timestamps, simultaneous bids, strong voice matches, ambiguous speakers, and stale/low-confidence audio.
