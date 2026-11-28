# Spoken chat: every chat message read out loud (2026-11-28)

User request (2026-11-28): "all chat messages from all platforms and all streams need to be spoken out loud as well".
User choices: voice = Speaker.bot (already installed and run by the user); heard by viewers and the user (its own
mixer strip on the stream); add Facebook Page Live comments to the chat Ujwalam reads.

## How

1. Chat in: YouTube, Twitch, Kick already arrive through the read-only Streamer.bot connection
   (`services/event-core/streamerbot/map.mjs`, kind `chat.message`). New: Facebook Page Live comments read through the
   Meta Page connection (D447) while a Facebook broadcast is live, polled within Meta's rate limits, as `chat.message`
   with platform `facebook`. Instagram Live comments: Meta delivers them only by webhook to a public server, so a PC
   app most likely cannot read them (UNVERIFIED; not built).
2. Filter (chat is untrusted data): skip links, commands (`!...`), known bot accounts, repeats and floods; cut long
   messages; a word list (data, user-editable); never read tokens, emails or numbers that look like phone numbers.
   Values (max length, rate, skip-ahead backlog) live in a data file, tunable in Settings.
3. Queue: one message at a time; when the backlog passes the limit the oldest are dropped, so speech is never minutes
   behind. "Skip" and "Mute speech" in the studio, switchable while live.
4. Voice: each message goes to Speaker.bot's WebSocket (its Speak request; exact request shape to be checked against
   Speaker.bot's docs and a real Speaker.bot, UNVERIFIED until then). Optional "name says: message" form.
5. Sound on the stream: a "Spoken chat" mixer strip that captures Speaker.bot's application audio (the app sound
   capture from AU2), its own volume and mute, on the stream mix and the monitor.
6. Ujwalam stays read-only towards Streamer.bot (unchanged). The "Ujwalam never speaks" line of the live test kit now
   reads: Ujwalam speaks chat only through Speaker.bot when Spoken chat is on.

Ships ON (requested feature, inline toggle in Settings > Chat), switchable while live. Done only after one real stream.
