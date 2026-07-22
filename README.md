# Sun God Auction Systems

Sun God Auction Systems is a local-first fantasy football auction draft room with selectable ElevenLabs or Cartesia speech, an AI Patter Director, zero-install phone bidding, salary-cap enforcement, live rosters, and a reversible sale ledger.

## Run it

```bash
./start.command
```

The launcher uses Node from your shell when available and otherwise uses the Node runtime bundled with Codex. You do not need `npm`, a participant app, or bidder accounts to run the core draft room.

Then open `http://localhost:4173` in Chrome. Keep the laptop and bidder phones on the same Wi-Fi network.

No API key is required for the core draft room. ElevenLabs and Cartesia can power the upgraded realtime auctioneer when configured; Auto mode prefers ElevenLabs, then Cartesia, then the browser voice. Participant bids are submitted only through their claimed phone controls.

Lucy delivers dark, vulgar fantasy-football roasts after completed sales by default. Open **Lucy’s booth** to turn roasts off for the league. With `OPENAI_API_KEY`, the ten supplied house lines calibrate the first ten contextual roasts; every later sale still calls OpenAI but requires a genuinely new premise rather than cycling those examples. Lucy remembers the twenty most recent results to suppress repetition. The built-in rotation is used only when OpenAI is unavailable. Only displayed draft facts are sent to OpenAI—never phone identifiers or claim tokens. Death, drug, injury, and financial-ruin hyperbole is explicitly allowed, while invented real-player news and protected-trait jokes remain out of bounds. Set `OPENAI_ROAST_MODEL` to override the default low-latency `gpt-5.6-luna` writer.

## Realtime AI auctioneer

ElevenLabs supplies the voice performance, not the auction content. Sun God owns the words: deterministic calls handle official bids and countdowns, while the optional OpenAI Patter Director writes short live arcs from the current player, bidder, price, budget, roster, and recent sales.

### ElevenLabs auction voice

Sun God keeps one ElevenLabs multi-context WebSocket warm on the Mac. Each announcement gets an independent context on that socket. A bid received during a spoken line waits for that line to finish; additional valid bids replace the queued announcement so Lucy calls only the latest high bid.

1. Create an ElevenLabs API key.
2. In the ElevenLabs Voice Library, save or share the auction voice you want and copy its voice ID.
3. Copy `.env.example` to `.env`, then set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`.
4. Restart Sun God and choose **ElevenLabs** or **Auto** in Lucy's booth.

The server exchanges the permanent key for a single-use WebSocket token. The permanent ElevenLabs key is never sent to the browser. Sun God defaults to the low-latency `eleven_flash_v2_5` model; override it with `ELEVENLABS_MODEL` only with another model compatible with ElevenLabs' multi-context WebSocket.

### Cartesia Lucy

Sun God keeps a Cartesia WebSocket warm on the Mac and streams raw audio to the host browser. Every announcement has its own speech context. Valid phone bids update the auction immediately, then wait for the current spoken line to finish before Lucy gives a fresh, energetic acknowledgement; countdowns, rulings, nominations, and sales each use different pacing and emotional direction.

1. Create a Cartesia API key at `https://play.cartesia.ai/keys`.
2. If you have not already created local configuration, run:

   ```bash
   cp .env.example .env
   open -e .env
   ```

3. Put the key after `CARTESIA_API_KEY=` and restart with `./start.command`.
4. Restart Sun God. The volume button in the host header reports the active auctioneer provider when you hover over it.

The permanent Cartesia key stays in the Mac's local `.env` file and is read only by `server.mjs`. The browser receives only generated PCM audio. The default is Cartesia's British Lucy voice on `sonic-3.5`; set `CARTESIA_VOICE_ID` in `.env` to any voice ID from the Cartesia playground to change it.

Click the volume control to open **Lucy’s booth** before the draft. The room check speaks “Can you hear Lucy?” using the currently selected settings. Choose among Lucy Classic, Stadium Pulse, and League Pro personalities, set the energy to Measured, Draft night, or Full send, and choose whether Lucy should run continuous play-by-play or roast the bidders. These choices change both the auction script and realtime performance direction and persist on the draft laptop.

Continuous play-by-play is on by default. With `OPENAI_API_KEY` configured, the AI Patter Director prepares exactly three short connected lines while the current passage is playing, using the player, current leader, price, next bid, suggested value, budget, roster, bid count, and recent sales. Those lines are combined into one longer TTS request for more consistent delivery. Its prompt asks for the escalation and celebratory release of elite Latin American soccer commentary without imitating an accent or inventing football facts. Every price, phase, or leader change invalidates the queued lines before they can become stale. If OpenAI is unavailable or slow, Lucy immediately builds the same three-line passage from the local rotating script instead. Set `OPENAI_PATTER_MODEL` to override the default `gpt-5.6-luna` director.

Higher energy levels leave less air between lines. New bids finish the current spoken line and collapse into one latest-high-bid announcement. Ties, pauses, countdown calls, and sales can still interrupt, and the statutory countdown starts after the bid announcement finishes.

Completed countdown calls are cached in a bounded in-memory audio cache, keyed by phrase, voice, personality, and energy. Repeated calls can play without another generation round trip. If realtime speech is unavailable or stalls, the host switches that announcement to a preferred English browser voice with matching energy and pacing. Opening Lucy’s booth refreshes status and retries the configured realtime provider.

## Phone bidding

The laptop creates a private room code and a join link using its local network address. No participant app or account is required.

1. Finish the team order in **League setup**.
2. Each participant scans the QR code in the **Phone bidding** panel.
3. The participant chooses their manager. Sun God prevents another phone from claiming the same team.
4. During an auction, the phone's **Auction** tab shows the player, current bid, budget, maximum legal bid, and roster count. Managers can tap the large next-dollar **Bid** button, choose one of two round-number **Easy bids** interpolated toward the player's suggested value, or enter any legal whole-dollar amount. The **Roster** tab lists every purchased player and price.
5. The laptop receives the bid, enforces the increment and budget, announces it, and updates every phone.

Bid requests are timestamped when the Sun God server receives them. Within the same 300 ms window, the highest submitted amount wins; if multiple managers submit that same highest amount, the auction pauses and displays those managers so the laptop operator can make a ruling without silently choosing based on network order.

The QR code is generated locally. Phone requests stay between the participant devices and the Mac running Sun God. If a phone cannot open the join page, confirm both devices are on the same non-guest Wi-Fi network, disconnect any VPN, and allow incoming network connections if macOS asks.

## Draft flow

1. The manager shown as **is up** chooses a player; click that player in **On deck** to nominate them.
2. Click **Start auction**.
3. Participants tap **Bid** on their phones. The laptop team buttons and number keys remain available to the operator for administration and rulings.
4. The automatic countdown gives the room eight seconds before “going once,” then five seconds before “going twice,” and just over four seconds before sale. Any valid bid resets it.
5. Completed sales update the team's budget and roster. **Undo last** reverses the most recent sale.

The nomination turn follows the order configured during league setup and advances after either a sale or a no-bid pass. Undoing a sale restores the prior nominator along with the player, budget, and roster.

### Hybrid auto draft

Mark any team as **Auto draft** during league setup. Auto teams cannot be claimed by a phone. When a player is nominated, Sun God makes one batched strategic decision for every auto team: **pass**, **value**, or **target**. A pass stays silent for the whole lot, value bids only below a discounted ceiling, and target can bid up to the full locally calculated ceiling. Exact bid amounts, timing, roster eligibility, salary-cap reserves, and every state change remain deterministic and pass through the same auction engine as human bids. Auto teams enter against a human at the next normal increment; bot-versus-bot bidding uses legal proxy-style jumps so Lucy does not have to announce a long one-dollar bidding loop.

With `OPENAI_API_KEY`, the server uses one structured `gpt-5.6-luna` request per nomination and freezes the result before live bidding. The model receives only displayed draft facts, team construction, positional availability, and recent price/value ratios—never phone tokens or identifiers. If the request is unavailable, invalid, late, or slower than 1.8 seconds, the balanced local strategy is used immediately and any late response is ignored. Set `OPENAI_AUTODRAFT_MODEL` to override the intent model.

Auto nominators choose a legal player from the remaining pool and start the next auction after their intent decisions are ready. Human nominators keep the normal player-board and **Start auction** controls. The host can pause, undo, or use the laptop bid buttons at any time.

## Five-minute league setup

Open **League setup** from the header to configure a draft in three guided steps:

1. Set the team count, salary cap, and bid increment.
2. Set required QB, RB, WR, TE, FLEX, K, and DST slots plus unrestricted bench slots. FLEX accepts RB, WR, or TE.
3. Enter teams and managers from top to bottom in their repeating nomination order, then mark any teams that should use auto draft.

Roster requirements are draft rules, not just a template. Sun God blocks laptop and phone bids when buying that player's position would leave the team with too few open roster spots to complete its required lineup. The usual one-dollar reserve for every remaining roster spot still applies.

Number keys 1–9 place quick bids. Space advances the countdown manually.

## Player CSV

The **Load FantasyPros values** button on the player board replaces the current draft with the supplied 315-player FantasyPros auction list in a single click. It preserves the league's teams, budget, roster size, and bid increment while clearing sales and rosters for a fresh draft. Because the supplied list does not include NFL-team abbreviations, those players display `FA`; positions are included for draft filtering and display.

Importing a CSV opens a column-mapping preview before it resets the draft. Map player name and position, then optionally map NFL team and suggested auction value. Common headings such as `Player Name`, `Athlete`, `Pos`, `Pro Team`, and `Auction Value` are matched automatically, while quoted names and values containing commas are supported.

```csv
name,position,team,value
Puka Nacua,WR,LAR,42
Bijan Robinson,RB,ATL,55
```

The default player board is demo data. The built-in FantasyPros preset reflects the supplied snapshot and does not fetch or silently update values from the internet.

## Results and exports

Open **View & export results** in the draft ledger for a post-draft report with league totals, top sale, best value versus suggested price, team spending, and final rosters. The report URL contains a compressed snapshot of the results, so copying the share link preserves that exact draft even if the commissioner later changes local state.

The results page can download a universal CSV or copy tab-separated tables arranged for ESPN, Yahoo, or Sleeper. These copy formats are designed for clean transfer into league tools or spreadsheets; each platform may still require its own commissioner-side import or roster-assignment workflow.

## Architecture notes

- `src/domain.mjs` is the deterministic auction engine. Phones cannot mutate budgets directly.
- `src/app.mjs` coordinates the host room, phone bid decisions, auctioneer direction, and the auction UI.
- `src/auctioneer-script.mjs` rotates natural nomination, bid, continuous patter, countdown, sale, and ruling lines without changing auction state.
- `src/auctioneer-patter.mjs` owns the energy-sensitive gap timing, live-phase boundary, and long-passage assembly for continuous commentary.
- `src/patter-director.mjs` bounds the live context and owns the three-line momentum prompt and strict output contract.
- `src/openai-patter-service.mjs` prefetches structured patter queues through the OpenAI Responses API without blocking local fallback.
- `src/autodraft.mjs` owns deterministic local intent fallback, valuation ceilings, nominations, reaction timing, and bid selection.
- `src/autodraft-intent.mjs` bounds the team-construction context and owns the strict pass/value/target response contract.
- `src/openai-autodraft-service.mjs` makes one batched, time-bounded OpenAI Responses API request per nomination and atomically falls back to local decisions.
- `src/roast-engine.mjs` owns Lucy's fantasy-football reference rotation, contextual fallback lines, and truth/taste prompt constraints.
- `src/openai-roast-service.mjs` writes short context-aware roasts through the OpenAI Responses API while keeping the permanent key server-side.
- `src/auctioneer-voice.mjs` streams provider PCM into an interruptible Web Audio queue and owns browser-voice fallback.
- `src/elevenlabs-speech-service.mjs` keeps one token-authenticated multi-context ElevenLabs WebSocket warm and closes individual contexts on interruption.
- `src/cartesia-speech-service.mjs` keeps the authenticated Cartesia WebSocket warm, applies per-event performance direction, and multiplexes speech contexts without exposing the API key.
- `src/auctioneer-speech-providers.mjs` resolves explicit provider choices and the ElevenLabs → Cartesia → browser Auto order.
- `src/bidder.mjs` renders the zero-install participant experience and submits authenticated team bids.
- `src/phone-bidding.mjs` calculates round-number easy bids and resolves simultaneous jump bids by amount.
- `src/phone-room-hub.mjs` owns room codes, exclusive team claims, server timestamps, live state, and participant events.
- `src/vision-bidding.mjs` supplies the shared 300 ms simultaneous-bid classification used by the host.
- `server.mjs` serves the host and phone pages, broadcasts local room events, directs patter, and relays ElevenLabs or Cartesia speech; permanent provider keys remain server-side.
- Draft state is persisted in `localStorage`.
- Phone-room traffic stays on the local network. Sun God does not capture or transcribe bidder audio.
- ElevenLabs and Cartesia are selectable production voice providers; the browser speech engine remains the automatic final fallback.

## Test

```bash
node --test
```

The tests cover bid increments, coalesced bid announcements, reserve-budget rules, countdown transitions, completed sales, undo, no-bid queue rotation, phone-room claims/state/server timestamps, auto-team claim protection, deterministic auto-bid ceilings and termination, structured AI intent fallback, custom and easy phone bids, simultaneous bids, persistent ElevenLabs and Cartesia speech streaming, provider selection, and structured AI patter generation.
