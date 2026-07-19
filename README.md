# Sun God Auction Systems

Sun God Auction Systems is a local-first fantasy football auction draft room with a reactive Cartesia AI auctioneer, zero-install phone bidding, salary-cap enforcement, live rosters, and a reversible sale ledger.

## Run it

```bash
./start.command
```

The launcher uses Node from your shell when available and otherwise uses the Node runtime bundled with Codex. You do not need `npm`, a participant app, or bidder accounts to run the core draft room.

Then open `http://localhost:4173` in Chrome. Keep the laptop and bidder phones on the same Wi-Fi network.

No API key is required for the core draft room. Cartesia powers the upgraded realtime auctioneer when configured and automatically falls back to the browser voice otherwise. Participant bids are submitted only through their claimed phone controls.

## Cartesia AI auctioneer

Sun God keeps a Cartesia WebSocket warm on the Mac and streams raw audio to the host browser. Every announcement has its own speech context. A valid phone bid immediately stops the currently scheduled audio and begins a fresh, energetic bid acknowledgement; countdowns, rulings, nominations, and sales each use different pacing and emotional direction.

1. Create a Cartesia API key at `https://play.cartesia.ai/keys`.
2. If you have not already created local configuration, run:

   ```bash
   cp .env.example .env
   open -e .env
   ```

3. Put the key after `CARTESIA_API_KEY=` and restart with `./start.command`.
4. Restart Sun God. The volume button in the host header reports the active auctioneer provider when you hover over it.

The permanent Cartesia key stays in the Mac's local `.env` file and is read only by `server.mjs`. The browser receives only generated PCM audio. The default is Cartesia's British Lucy voice on `sonic-3.5`; set `CARTESIA_VOICE_ID` in `.env` to any voice ID from the Cartesia playground to change it. If Cartesia is unconfigured or temporarily unavailable, Sun God automatically uses the operating system's browser voice so the draft can continue.

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

## Five-minute league setup

Open **League setup** from the header to configure a draft in three guided steps:

1. Set the team count, salary cap, and bid increment.
2. Set required QB, RB, WR, TE, FLEX, K, and DST slots plus unrestricted bench slots. FLEX accepts RB, WR, or TE.
3. Enter teams and managers from top to bottom in their repeating nomination order.

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
- `src/auctioneer-script.mjs` rotates natural nomination, bid, countdown, sale, and ruling lines without changing auction state.
- `src/auctioneer-voice.mjs` streams Cartesia PCM into an interruptible Web Audio queue and owns browser-voice fallback.
- `src/cartesia-speech-service.mjs` keeps the authenticated Cartesia WebSocket warm, applies per-event performance direction, and multiplexes speech contexts without exposing the API key.
- `src/bidder.mjs` renders the zero-install participant experience and submits authenticated team bids.
- `src/phone-bidding.mjs` calculates round-number easy bids and resolves simultaneous jump bids by amount.
- `src/phone-room-hub.mjs` owns room codes, exclusive team claims, server timestamps, live state, and participant events.
- `src/vision-bidding.mjs` supplies the shared 300 ms simultaneous-bid classification used by the host.
- `server.mjs` serves the host and phone pages, broadcasts local room events, and relays Cartesia speech; the permanent Cartesia API key remains server-side.
- Draft state is persisted in `localStorage`.
- Phone-room traffic stays on the local network. Sun God does not capture or transcribe bidder audio.
- Cartesia is the production auctioneer voice provider; the browser speech engine remains an automatic fallback.

## Test

```bash
node --test
```

The tests cover bid increments, reserve-budget rules, countdown transitions, completed sales, undo, no-bid queue rotation, phone-room claims/state/server timestamps, custom and easy phone bids, simultaneous bids, and Cartesia speech streaming.
