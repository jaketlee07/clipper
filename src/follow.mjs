// Follow: keeps clipping a streamer's broadcast while it's live. Every few minutes
// it checks their newest VODs and, once a full chunk of new footage is up, runs
// the clip pipeline on it (which pings Discord with the clips), then deletes the
// downloaded footage. The clips stay. Chunks overlap a little so a moment on the
// boundary isn't cut in half; the pipeline skips moments it already clipped.
//
// Leave it running in its own terminal, with caffeinate so the Mac doesn't sleep:
//
//   caffeinate -i npm run follow -- --campaign lacy-gta
//
//   --chunk 30      minutes of footage per run (default 30)
//   --count 3       clips per chunk at most (default 3)
//   --every 5       minutes between checks (default 5)
//   --backlog 60    how far back into the live broadcast to start, in minutes (default 60)
//   --once          check once, process what's ready, and stop
//
// Where it got to is saved in media/follow-<campaign>.json, so stopping and
// starting again picks up where it left off, going back at most --backlog
// minutes. The Discord bot (src/bot.mjs) runs the same loop for one broadcast.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadCampaign, loadStreamer } from "./config.mjs";
import { discordConfigured, sendWebhook } from "./discord.mjs";
import { recentVods, twitchConfigured } from "./signals/twitch.mjs";
import { MEDIA, clock, parseArgs } from "./util.mjs";

const CLIP = fileURLToPath(new URL("./clip.mjs", import.meta.url));
const LAG = 3 * 60; // Twitch's VOD runs a little behind the live stream
const OVERLAP = 60;
const MAX_TRIES = 3;
const NO_VOD_GIVE_UP = 20 * 60 * 1000;

const stamp = (text) => console.log(`[${new Date().toLocaleTimeString()}] ${text}`);

// The next stretch of a VOD to clip, or null if there isn't a full chunk yet.
// A finished VOD's last stretch is taken even when shorter than a chunk.
export function nextChunk(vod, done, { chunk, minSeconds }) {
  const available = vod.live ? vod.duration - LAG : vod.duration;
  if (available - done >= chunk) return { from: Math.max(0, done - OVERLAP), to: done + chunk };
  if (!vod.live && available - done >= minSeconds) return { from: Math.max(0, done - OVERLAP), to: vod.duration };
  return null;
}

// Where to pick a VOD up when following starts: the live broadcast goes back at
// most `backlog` seconds (so a long pause isn't clipped all at once), a VOD that
// was being followed finishes its tail, and older broadcasts are left alone.
export function startState(vod, saved, backlog) {
  if (saved?.finished) return saved;
  if (vod.live) return { ...saved, done: Math.max(saved?.done ?? 0, vod.duration - backlog) };
  if (saved) return saved;
  return { done: vod.duration, finished: true, skipped: "ended before following started" };
}

// Whether a VOD is the recording of this broadcast.
export const isRecordingOf = (vod, stream) =>
  vod.streamId ? vod.streamId === stream.id : Math.abs(new Date(vod.createdAt) - new Date(stream.startedAt)) < 10 * 60 * 1000;

// One clip run at a time, even when several campaigns are being followed.
let queue = Promise.resolve();
function runClip(args, signal) {
  const run = queue.then(
    () =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve(false);
        const child = spawn(process.execPath, [CLIP, ...args], { stdio: "inherit", signal, killSignal: "SIGTERM" });
        child.on("error", () => {});
        child.on("exit", (code) => resolve(code === 0));
      }),
  );
  queue = run.catch(() => {});
  return run;
}

function chunkClips(vodId, from) {
  const path = `${MEDIA}twitch-${vodId}-${Math.round(from)}/clips.json`;
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")).clips.filter((c) => c.video);
  } catch {
    return [];
  }
}

// Follows a streamer and clips their broadcasts, until `signal` aborts it (or,
// with `stream`, until that one broadcast is over and fully clipped).
//
//   stream    only this broadcast ({ id, startedAt } from Twitch); default: every broadcast, forever
//   onEvent   called with { type: "start" | "chunk" | "clipped" | "failed" | "over", ... }
//
// Resolves to { over, stopped, chunks, clips }.
export async function follow({ campaign, streamer, chunk = 1800, count = 3, every = 300, backlog = 3600, once = false, stream = null, signal, onEvent = () => {}, log = stamp }) {
  mkdirSync(MEDIA, { recursive: true });
  const statePath = `${MEDIA}follow-${campaign.id}.json`;
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { startedAt: new Date().toISOString(), vods: {} };
  const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const opts = { chunk, minSeconds: campaign.minSeconds };
  const result = { over: false, stopped: false, chunks: 0, clips: 0 };
  const began = Date.now();
  const seen = new Set();
  const emit = (event) => {
    try {
      onEvent(event);
    } catch (err) {
      log(`onEvent: ${err.message}`);
    }
  };

  log(`Following twitch.tv/${streamer.twitch}${stream ? ` (the broadcast that started ${new Date(stream.startedAt).toLocaleString()})` : ""} for ${campaign.name}: ${chunk / 60}-minute chunks, up to ${count} clips each.`);
  for (;;) {
    if (signal?.aborted) return { ...result, stopped: true };
    let vods = null;
    try {
      vods = (await recentVods(streamer.twitch, 5)).reverse(); // oldest first
    } catch (err) {
      log(`Twitch: ${err.message}`);
    }
    if (vods && stream) vods = vods.filter((v) => isRecordingOf(v, stream));

    for (const v of vods ?? []) {
      if (!seen.has(v.id)) {
        // First time this run: decide where to pick it up.
        seen.add(v.id);
        const before = state.vods[v.id];
        state.vods[v.id] = startState(v, before, backlog);
        save();
        const s = state.vods[v.id];
        if (v.live && before && s.done > before.done) log(`VOD ${v.id}: skipping ${clock(before.done)} to ${clock(s.done)}, more than ${backlog / 60} minutes back.`);
        if (!s.finished) emit({ type: "start", vod: v, from: s.done });
      }
      const s = state.vods[v.id];
      if (s.finished) continue;
      let next;
      while ((next = nextChunk(v, s.done, opts))) {
        if (signal?.aborted) return { ...result, stopped: true };
        log(`VOD ${v.id}: clipping ${clock(next.from)} to ${clock(next.to)}${v.live ? " (live)" : ""}`);
        emit({ type: "chunk", vod: v, ...next });
        const ok = await runClip([`https://www.twitch.tv/videos/${v.id}`, "--campaign", campaign.id, "--from", String(next.from), "--to", String(next.to), "--count", String(count)], signal);
        rmSync(`${MEDIA}twitch-${v.id}-${Math.round(next.from)}/source.mp4`, { force: true });
        if (signal?.aborted) return { ...result, stopped: true };
        if (ok) {
          const clips = chunkClips(v.id, next.from);
          result.chunks++;
          result.clips += clips.length;
          s.done = next.to;
          s.tries = 0;
          emit({ type: "clipped", vod: v, ...next, clips });
        } else {
          s.tries = (s.tries ?? 0) + 1;
          log(`That chunk failed (try ${s.tries} of ${MAX_TRIES}).`);
          const gaveUp = s.tries >= MAX_TRIES;
          emit({ type: "failed", vod: v, ...next, tries: s.tries, gaveUp });
          if (!gaveUp) {
            save();
            break;
          }
          if (discordConfigured()) await sendWebhook({ content: `⚠️ Follow: skipped ${clock(next.from)} to ${clock(next.to)} of VOD ${v.id} after ${MAX_TRIES} failed tries. Check the terminal.` }).catch((err) => log(`Discord: ${err.message}`));
          s.done = next.to;
          s.tries = 0;
        }
        save();
      }
      if (!v.live && v.duration - s.done < opts.minSeconds) {
        s.finished = true;
        save();
        log(`VOD ${v.id} is over and fully clipped.`);
      }
    }

    if (stream && vods) {
      const mine = vods[0];
      if (mine && state.vods[mine.id]?.finished) {
        emit({ type: "over", vod: mine });
        return { ...result, over: true };
      }
      if (!mine && Date.now() - began > NO_VOD_GIVE_UP) throw new Error(`Twitch hasn't made a VOD of this broadcast after ${NO_VOD_GIVE_UP / 60000} minutes, so there's nothing to clip. Past broadcasts may be switched off on the channel.`);
    }
    if (once) return result;
    try {
      await sleep(every * 1000, null, { signal });
    } catch {
      return { ...result, stopped: true };
    }
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), ["once"]);
  if (!flags.campaign) throw new Error("Which campaign? Add --campaign <name> (a file in campaigns/).");
  if (!twitchConfigured()) throw new Error("Following needs the Twitch API: set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env.");
  const campaign = loadCampaign(flags.campaign);
  const streamer = loadStreamer(campaign.streamer);
  if (!streamer.twitch) throw new Error(`streamers/${campaign.streamer}.json has no "twitch" login to follow.`);
  const minutes = (name, fallback) => Number(flags[name] ?? fallback) * 60;
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  await follow({
    campaign,
    streamer,
    chunk: minutes("chunk", 30),
    count: Number(flags.count ?? 3),
    every: minutes("every", 5),
    backlog: minutes("backlog", 60),
    once: flags.once === true,
    signal: stop.signal,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n${err.stack ?? err.message}`);
    process.exit(1);
  });
}
