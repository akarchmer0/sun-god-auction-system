# Personal remote bidding setup

Sun God’s remote mode is designed for members of one private league. There are no customer accounts, payments, license files, or expiration dates. You run one Cloudflare Worker and protect room creation with a private admin secret.

## Deploy the relay

From the project directory:

1. Install dependencies with `pnpm install`.
2. Create a secret with `openssl rand -base64 32`.
3. Run `pnpm exec wrangler secret put RELAY_ADMIN_SECRET --config relay/wrangler.toml` and paste the secret.
4. Run `pnpm relay:deploy`.
5. Copy the deployed `https://sun-god-personal-relay.<your-subdomain>.workers.dev` URL.

Do not put the real secret in `relay/wrangler.toml` or commit it to Git.

## Configure the host

For `./start.command`, copy `.env.example` to `.env` and set:

```dotenv
SUN_GOD_RELAY_URL=https://sun-god-personal-relay.your-subdomain.workers.dev
SUN_GOD_RELAY_ADMIN_SECRET=the_same_long_secret
```

Restart Sun God after changing `.env`.

For the desktop app, enter the same URL and secret during Commissioner setup. They are stored through Electron safeStorage and macOS Keychain. Restart the app after saving them.

## Draft night

Click **Enable remote bidders** before sharing the QR code. Wait for the room status to show **LIVE**, then have each league member scan or open the same link and claim their team. Local and remote members should all use that relay link once remote mode is enabled.

Lucy’s auctioneer transcript is forwarded to remote bidder phones and read with each phone’s browser voice. Mobile browsers require a user gesture before playing sound, so tap the amber speaker once. The button says “Phone audio on” when successfully enabled, turns green when sound is ready, and can mute or re-enable that phone without affecting anyone else.

If the button reports that remote bidding is not configured, verify both settings and restart the host. If authorization fails, replace the Worker secret and host secret with the same new value. If a participant page opens but does not become connected, confirm the current room link was shared; room links expire after 24 hours and are replaced whenever a new remote room is created.
