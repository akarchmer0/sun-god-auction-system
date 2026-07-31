# Privacy Notice

Sun God Auctioneer is local-first. Draft rules, the commissioner audit journal, provider credentials, and backups remain on the commissioner’s Mac. Provider credentials are encrypted using Electron safeStorage backed by macOS Keychain.

When remote mode is enabled, the commissioner’s personal relay receives only the public room snapshot, team-claim hashes, connection metadata, bid messages, and expiration time. It does not receive provider API keys, the relay admin secret, audio, video, private backups, or the full audit journal. Relay rooms are deleted when closed or no later than 24 hours after creation.

Optional OpenAI, ElevenLabs, and Cartesia features send the minimum content needed to generate the requested text or speech under those providers’ own terms. Sun God does not provide conferencing; Zoom, Meet, Discord, FaceTime, or another call is governed by its provider. Diagnostic exports omit secrets, tokens, and participant names unless the commissioner explicitly elects to include them.
