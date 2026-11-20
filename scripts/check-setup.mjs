// Checks the tools and keys the pipeline uses, without printing any key.
//   npm run check
import { loadEnv } from "../src/env.mjs";
import { has } from "../src/util.mjs";

const env = loadEnv();
const rows = [];
const row = (ok, name, note) => rows.push(`${ok === true ? "✅" : ok === false ? "❌" : "➖"} ${name}${note ? `: ${note}` : ""}`);

row(Number(process.versions.node.split(".")[0]) >= 22, "Node 22+", process.version);
row(has("ffmpeg"), "ffmpeg", has("ffmpeg") ? "" : "brew install ffmpeg (required)");
row(has("yt-dlp", ["--version"]) || null, "yt-dlp", has("yt-dlp", ["--version"]) ? "" : "brew install yt-dlp (needed for Twitch VOD links)");
row(has("whisper-cli", ["--help"]) || null, "whisper-cli", has("whisper-cli", ["--help"]) ? "" : "brew install whisper-cpp (needed for captions)");

if (env.ANTHROPIC_API_KEY) {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
  row(res.ok, "Anthropic API key", res.ok ? "" : `HTTP ${res.status}`);
} else row(null, "Anthropic API key", "not set: clips are ranked by signals only, with no hooks");

for (const [key, label] of [["DISCORD_WEBHOOK_URL", "Discord #clips-ready webhook"], ["DISCORD_POSTED_WEBHOOK_URL", "Discord #posted webhook"]]) {
  if (!env[key]) {
    row(null, label, key === "DISCORD_WEBHOOK_URL" ? "not set: no Discord pings" : "not set: uses the #clips-ready webhook");
    continue;
  }
  const res = await fetch(env[key]);
  row(res.ok, label, res.ok ? `posts to channel ${(await res.json()).channel_id}` : `HTTP ${res.status}`);
}

if (env.DISCORD_BOT_TOKEN) {
  const res = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
  row(res.ok, "Discord bot", res.ok ? `logged in as ${(await res.json()).username}` : `HTTP ${res.status}: check DISCORD_BOT_TOKEN`);
} else row(null, "Discord bot", "not set: no live pings with Clip it buttons (npm run bot)");

if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  row(res.ok, "Twitch API", res.ok ? "" : `HTTP ${res.status}`);
} else row(null, "Twitch API", "not set: no viewer-clip signal or VOD details");

console.log(rows.join("\n"));
