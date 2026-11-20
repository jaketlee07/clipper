# clipper

Turns a streamer's VOD (or a file a campaign provides) into ranked, vertical, captioned clips for clipping campaigns, checks them against the campaign's rules, and pings Discord.

```
npm run clip -- https://www.twitch.tv/videos/123456789 --campaign tomo --chat chat.json
```

1. **Ingest**: a local file, a Twitch VOD link (downloaded with yt-dlp; `--from`/`--to` grabs only part of it), or a direct link to a file. YouTube links are refused by default: downloading from YouTube goes against its terms even when a campaign allows clipping.
2. **Signals**, merged into one score per 10 seconds:
   - Twitch viewer clips from the official API, weighted by views (catches chases and crashes where nobody talks).
   - Chat replay: unique chatters per 10 seconds, not messages, so bots and copypasta don't fake hype; "clip it" calls count extra. Pass a chat export with `--chat` (TwitchDownloader's JSON, or yt-dlp's `live_chat.json`). Twitch has no official chat-replay API.
   - Loudness per second from ffmpeg, and sudden jumps in it.
3. **Transcribe** only the top candidate moments with Whisper (whisper.cpp, free, on your machine), so an 8-hour VOD takes minutes. Or pass `--transcript` with an `.srt`/`.vtt`.
4. **Pick**: Claude ranks the moments against the campaign brief and returns each clip's cut (snapped to word boundaries, inside the campaign's length limits), a hook title, a caption and a score. About $0.10 per VOD. Without an API key, clips are cut around the signal peaks with no hook.
5. **Check frames**: Claude looks at a frame every 2 seconds of each pick, with the part that will be on screen boxed. It trims menus, maps, loading and black screens off the ends, cuts or drops footage that breaks the campaign's on-screen rules (`visualRules`, e.g. "no logos"), and marks IRL camera footage for the full-frame layout. Picks are checked best first until enough pass. About $0.04 a clip; `--no-screen` skips it.
6. **Render** at 1080x1920 in Remotion: facecam band over gameplay (or a blurred fill with no facecam, and for IRL footage), a slow push-in, word-by-word captions, a 2-second hook title, the streamer credit and the campaign's on-screen disclosure. UI-safe margins for TikTok, Reels and Shorts.
7. **Lint** each clip against `campaigns/<name>.json` (length, hashtags, mentions, disclosure, credit, banned words), adding missing tags to the caption and starring out swearing if the campaign asks.
8. **Discord**: a ping in #clips-ready with each clip attached (if under 10 MB), its hook, score, caption, VOD timestamp and any rule problems.

Output: `media/<job>/clips/NN-<hook>.mp4` with a `.txt` caption beside each, `clips.json`, and `signals.json` (every bucket's score, for tuning).

## While they're live

```
caffeinate -i npm run follow -- --campaign lacy-gta
```

Follows the campaign's streamer on Twitch. Every 5 minutes it checks their newest VODs, and once a full chunk of new footage is up (30 minutes by default; the VOD runs about 3 minutes behind live) it runs the pipeline on it, which pings #clips-ready, then deletes the downloaded footage. Each start goes back at most an hour into the live broadcast (`--backlog`), so a long pause isn't clipped all at once, and older VODs are left alone. A broadcast that starts while it's running is clipped from the start, and one that ends gets its last stretch clipped too. Progress is saved in `media/follow-<campaign>.json`. Chunks overlap by a minute, and the pipeline never clips a moment twice for the same campaign (`--repeat` on `npm run clip` overrides that). After 3 failed tries a chunk is skipped with a Discord warning. `caffeinate -i` keeps the Mac awake. Options: `--chunk`, `--count` (clips per chunk, default 3), `--every`, `--backlog`, `--once`.

### From your phone: the Discord bot

```
caffeinate -i npm run bot
```

Instead of starting `follow` yourself, leave the bot running. When the streamer of any campaign in `campaigns/` goes live, it pings you in #clips-ready with **Clip it** and **Skip** buttons. **Clip it** follows that broadcast (the same loop as above), and the message keeps a running count with a **Stop** button (**Resume** after stopping). When the broadcast ends it clips the last stretch and posts a summary. If a followed broadcast drops and comes back within 30 minutes, it keeps following without asking. `/clipper status`, `/clipper start` and `/clipper stop` do the same from anywhere in the server. Only you can use the buttons and the command. The Mac still does the clipping, so it has to be on, online and running the bot. If you stop the bot (Ctrl-C), it picks up where it left off when you start it again. Options: `--chunk`, `--count`, `--every` (minutes between live checks, default 2).

One-time setup, about 5 minutes:

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** (name it e.g. Clipper).
2. **Bot** → **Reset Token** → copy it into `.env` as `DISCORD_BOT_TOKEN`. It needs no privileged intents.
3. `npm run bot`. The first time, it prints an invite link. Open it, pick your server, and authorize. Then start it again.

It posts in the channel your `DISCORD_WEBHOOK_URL` posts to (set `DISCORD_BOT_CHANNEL_ID` for another one), and only the application's owner (you) can press its buttons (set `DISCORD_OWNER_ID` to a comma-separated list of user IDs to change that). For the ping to reach your phone, allow notifications for mentions in that server.

## After you post

```
npm run posted -- https://www.tiktok.com/@you/video/123 --campaign tomo
```

Pings Discord with the Content Rewards submit link and a live countdown to the 30-minute deadline, pings again with 10 minutes left, and logs the post to `media/posts.jsonl`. Content Rewards has no public API, so the submission itself stays manual.

## Setup

```
brew install ffmpeg yt-dlp whisper-cpp
npm install
cp .env.example .env     # fill in what you have; every key is optional
npm run check
```

Whisper's model (574 MB) downloads on first use. Remotion downloads its own headless Chrome on first render.

### A new campaign

Copy `campaigns/example.json` to `campaigns/<name>.json` and fill it in from the brief. Every rule lives in that file, so each campaign gets its own:

| Field | What it does |
| --- | --- |
| `streamer`, `submitUrl`, `platforms` | Whose streams, where to submit, where clips go. |
| `minSeconds`, `maxSeconds`, `clipsPerVod` | Length limits (cuts are fitted to them) and how many clips a run makes. |
| `hashtags`, `mentions`, `captionMustInclude` | Added to the post caption if missing; lint fails without them. |
| `disclosure.caption`, `disclosure.onScreen`, `credit` | Paid-partnership text and the streamer credit, in the caption and burned into the video. |
| `bannedWords` | Lint fails a hook or caption that uses one. |
| `censorCaptions`, `censorWords` | Star out swearing (plus your own words) in burned captions, the hook and the post caption. The audio is untouched. |
| `visualRules` | What may not be on screen, in the brief's words ("No logos of any kind"). The frame check trims or drops footage that breaks them. |
| `notes` | Free text Claude follows when picking moments and writing hooks. |

### A new streamer

Copy `streamers/example.json` to `streamers/<name>.json`. Run `npm run frame -- <vod file> --at 10:00` for a still with a 100 px grid, and read the facecam box off it. Use `"layout": "full"` for streams with no facecam. `"irl"` is the crop for IRL camera footage, which the frame check spots and renders full-frame instead of stacked. Boxes scale automatically if a VOD is a different size.

## Commands

| Command | What it does |
| --- | --- |
| `npm run clip -- <input> --campaign <name>` | The whole pipeline. Options: `--streamer`, `--chat`, `--transcript`, `--from`/`--to`, `--count`, `--candidates`, `--repeat`, `--no-screen`, `--no-render`, `--no-discord`. |
| `npm run follow -- --campaign <name>` | Clips the streamer's live broadcast chunk by chunk until stopped. |
| `npm run bot` | Discord bot: asks when a campaign's streamer goes live, and follows the broadcast when you tap Clip it. |
| `npm run posted -- <link> --campaign <name>` | Submit reminder and post log. `--clip <file>` records which clip it was; `--no-remind` skips the 10-minute ping. |
| `npm run frame -- <file> [--at 10:00]` | Still with a grid, to measure a facecam box. |
| `npm run check` | Checks tools and keys without printing them. |
| `npm test` | Unit tests. |

## What's next

- Review queue in Notion (approve/reject per clip) and Buffer scheduling through n8n.
- Metrics: views at 12, 24 and 72 hours into a scoreboard, joined with `media/clips.jsonl` so signal weights and hook styles can be tuned on what actually got views.
- YouTube most-replayed heatmap as a signal for VODs where downloading is allowed.

## Credits

The Claude helper, Whisper invocation and caption component are adapted from [video-pipeline](https://github.com/jaketlee07/video-pipeline). The Twitch viewer-clip signal follows the approach of [OpenShorts](https://github.com/mutonby/openshorts) (MIT); no code was copied from it. Montserrat is under the SIL Open Font License (`remotion/fonts/OFL.txt`).
