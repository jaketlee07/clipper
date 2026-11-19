// Discord webhooks: a ping in #clips-ready when a VOD's clips are done (with the
// videos attached when they fit), and the 30-minute submit reminder after posting.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadEnv } from "./env.mjs";
import { clock } from "./util.mjs";

// Discord's upload limit for a server without boosts.
const MAX_ATTACHMENT = 10 * 1024 * 1024;

export const discordConfigured = (which = "ready") => {
  const env = loadEnv();
  return Boolean(which === "posted" ? env.DISCORD_POSTED_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL : env.DISCORD_WEBHOOK_URL);
};

export async function sendWebhook(payload, { file, which = "ready" } = {}) {
  const env = loadEnv();
  const url = which === "posted" ? env.DISCORD_POSTED_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL : env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("DISCORD_WEBHOOK_URL isn't set.");
  const body = { allowed_mentions: { parse: [] }, ...payload };
  let init;
  if (file) {
    const form = new FormData();
    form.set("payload_json", JSON.stringify(body));
    form.set("files[0]", new Blob([readFileSync(file)], { type: "video/mp4" }), basename(file));
    init = { method: "POST", body: form };
  } else {
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${url}?wait=true`, init);
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 2);
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      continue;
    }
    if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error("Discord kept rate-limiting the webhook.");
}

const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export async function notifyClipsReady(job, clips, { campaign, how }) {
  const source = job.meta?.title ? `${job.meta.name}: ${job.meta.title}` : basename(job.input);
  await sendWebhook({
    content: cut(`**${clips.length} clip${clips.length === 1 ? "" : "s"} ready** for ${campaign.name} from ${source} (${how}). Review, then post and run \`npm run posted -- <link> --campaign ${campaign.id}\` to start the 30-minute submit timer.`, 1900),
  });
  for (const clip of clips) {
    const vodTime = job.offset + clip.start;
    const lines = [
      `**#${clip.rank}${clip.hook ? ` · ${clip.hook}` : ""}**${clip.score ? ` · ${clip.score}/10` : ""}`,
      `${(clip.end - clip.start).toFixed(0)} s from ${clock(vodTime)} in the VOD${job.vodId ? ` (<https://www.twitch.tv/videos/${job.vodId}?t=${Math.floor(vodTime)}s>)` : ""}`,
      clip.why,
      `Caption: ${clip.lint.caption}`,
      clip.lint.errors.length ? `⛔ ${clip.lint.errors.join("; ")}` : "✅ Passes the campaign rules",
      clip.lint.warnings.length ? `⚠️ ${clip.lint.warnings.join("; ")}` : "",
    ].filter(Boolean);
    const attach = clip.video && clip.bytes <= MAX_ATTACHMENT;
    if (clip.video && !attach) lines.push(`File (${(clip.bytes / 1048576).toFixed(1)} MB, too big to attach): \`${clip.video}\``);
    await sendWebhook({ content: cut(lines.join("\n"), 1990) }, { file: attach ? clip.video : undefined });
  }
}
