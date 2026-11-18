// The MVP pipeline: a VOD or file in, ranked vertical clips out, and a Discord ping.
//
//   npm run clip -- <file | Twitch VOD link | direct file link> --campaign <name> [options]
//
//   --streamer <name>     streamers/<name>.json (facecam box). Default: the campaign's streamer
//   --chat <file>         chat replay export, for the unique-chatter signal
//   --transcript <file>   .srt/.vtt/.json words, instead of running Whisper
//   --from 1:00:00 --to 3:00:00   only this part of the VOD
//   --count 5             clips to make (default: the campaign's clipsPerVod)
//   --candidates 12       moments to transcribe and rank
//   --no-render           stop after ranking (writes clips.json only)
//   --no-discord          don't ping Discord
//   --allow-youtube       allow a YouTube link (only with rights to download it)
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totalSpent } from "./claude.mjs";
import { loadCampaign, loadStreamer } from "./config.mjs";
import { discordConfigured, notifyClipsReady } from "./discord.mjs";
import { ingest } from "./ingest.mjs";
import { lintClip } from "./lint.mjs";
import { pickClips } from "./pick.mjs";
import { renderClips } from "./render.mjs";
import { chatBuckets, readChat } from "./signals/chat.mjs";
import { loudness } from "./signals/loudness.mjs";
import { candidates, scoreBuckets } from "./signals/score.mjs";
import { vodClips } from "./signals/twitch.mjs";
import { transcribeCandidates } from "./transcript.mjs";
import { MEDIA, clock, parseArgs, parseClock, slugify } from "./util.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2), ["render", "discord", "allow-youtube"]);

async function main() {
  const input = positional[0];
  if (!input || !flags.campaign) throw new Error("Usage: npm run clip -- <file or Twitch VOD link> --campaign <name>. See the README for options.");
  const campaign = loadCampaign(flags.campaign);
  const streamer = loadStreamer(flags.streamer ?? campaign.streamer);
  const count = Number(flags.count ?? campaign.clipsPerVod);
  const started = Date.now();

  console.log(`1/6 Getting the video`);
  const job = await ingest(input, { from: parseClock(flags.from), to: parseClock(flags.to), allowYouTube: flags["allow-youtube"] === true });
  console.log(`  ${job.source.replace(MEDIA, "media/")}: ${clock(job.duration)}, ${job.width}x${job.height}`);
  if (!job.hasAudio) throw new Error("The video has no audio track.");

  console.log(`2/6 Finding moments`);
  const loud = loudness(job.source, job.window);
  const used = ["audio"];
  let chat = null;
  if (flags.chat) {
    const messages = readChat(flags.chat).map((m) => ({ ...m, t: m.t - job.offset }));
    chat = chatBuckets(messages);
    used.push(`chat (${messages.length.toLocaleString("en-US")} messages)`);
  }
  let clips = [];
  if (job.meta) {
    clips = (await vodClips(job.meta).catch((err) => (console.log(`  Twitch clips: ${err.message}`), []))).map((c) => ({ ...c, at: c.at - job.offset }));
    if (clips.length) used.push(`${clips.length} Twitch viewer clips`);
  }
  const buckets = scoreBuckets({ window: job.window, loud, chat, clips });
  const list = candidates(buckets, { count: Number(flags.candidates ?? Math.max(12, count * 2)), window: job.window, gap: campaign.maxSeconds + 15, before: campaign.maxSeconds * 0.75, after: Math.max(20, campaign.maxSeconds * 0.4) });
  console.log(`  Signals: ${used.join(", ")}. ${list.length} candidate moments.`);
  writeFileSync(join(job.dir, "signals.json"), `${JSON.stringify({ used, buckets, candidates: list }, null, 2)}\n`);

  console.log(`3/6 Transcribing the moments`);
  const how = await transcribeCandidates(job, list, { transcriptFile: flags.transcript, hint: [streamer.name, campaign.streamer, "GTA"].filter(Boolean).join(", ") });
  console.log(`  ${how}`);

  console.log(`4/6 Ranking and writing hooks`);
  const picked = await pickClips(list, { campaign, streamer, count });
  console.log(`  ${picked.clips.length} clips, ${picked.how}`);
  const byId = new Map(list.map((c) => [c.id, c]));
  const out = picked.clips.map((p, k) => {
    const words = (byId.get(p.candidate).words ?? []).filter((w) => w.end > p.start && w.start < p.end);
    return { rank: k + 1, ...p, words, file: `${String(k + 1).padStart(2, "0")}-${slugify(p.hook || `moment-at-${clock(job.offset + p.start)}`)}` };
  });

  if (flags.render !== false && out.length) {
    console.log(`5/6 Rendering ${out.length} vertical clips`);
    await renderClips(job, out, {
      campaign,
      streamer,
      onEach: (clip, seconds) => console.log(`  #${clip.rank} ${clip.file}.mp4 (${(clip.bytes / 1048576).toFixed(1)} MB, ${seconds} s)`),
    });
  } else console.log("5/6 Rendering skipped");

  for (const clip of out) {
    clip.lint = lintClip(clip, campaign);
    if (clip.video) writeFileSync(join(job.dir, "clips", `${clip.file}.txt`), `${clip.lint.caption}\n`);
  }
  const summary = out.map(({ words, ...c }) => ({ ...c, vodTime: job.offset + c.start, captionWords: words.length }));
  writeFileSync(join(job.dir, "clips.json"), `${JSON.stringify({ input, campaign: campaign.id, streamer: streamer.id ?? null, how: picked.how, clips: summary }, null, 2)}\n`);
  // One line per clip for the learning loop: which signals and hooks led to views.
  for (const c of summary) appendFileSync(`${MEDIA}clips.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), job: job.slug, campaign: campaign.id, rank: c.rank, file: c.file, hook: c.hook, score: c.score, seconds: c.end - c.start, vodTime: c.vodTime, signals: c.signals, ok: c.lint.ok })}\n`);

  console.log(`6/6 Notifying`);
  if (flags.discord === false) console.log("  Discord skipped");
  else if (!discordConfigured()) console.log("  No DISCORD_WEBHOOK_URL set, so no ping");
  else {
    await notifyClipsReady(job, out, { campaign, how: picked.how });
    console.log("  Pinged #clips-ready");
  }

  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)} s. Claude cost: about $${totalSpent().toFixed(2)}`);
  for (const c of out) {
    const flag = c.lint.ok ? "ok " : "FIX";
    console.log(`  ${flag} #${c.rank} ${clock(job.offset + c.start)} ${(c.end - c.start).toFixed(0)} s ${c.hook ? `"${c.hook}"` : ""}${c.score ? ` ${c.score}/10` : ""}`);
    for (const e of c.lint.errors) console.log(`        ⛔ ${e}`);
    for (const w of c.lint.warnings) console.log(`        ⚠ ${w}`);
  }
  if (out.some((c) => c.video)) console.log(`  Clips: media/${job.slug}/clips/`);
}

main().catch((err) => {
  console.error(`\n${err.stack ?? err.message}`);
  process.exit(1);
});
