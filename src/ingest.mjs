// Ingest: turns the input (a local file, a Twitch VOD link, or a direct link to a
// file a campaign provides) into media/<job>/source.mp4, plus what's known about it.
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, linkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { clock, has, jobDir, probe, slugify } from "./util.mjs";
import { twitchVideo } from "./signals/twitch.mjs";

export const twitchVodId = (input) => input.match(/twitch\.tv\/(?:[^/]+\/)?videos?\/(\d+)/)?.[1] ?? null;
const isYouTube = (input) => /(^|\/\/)(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(input);

export async function ingest(input, { from, to, allowYouTube = false } = {}) {
  if (isYouTube(input) && !allowYouTube) {
    throw new Error(
      "YouTube links are off by default: downloading from YouTube goes against its terms even when a campaign allows clipping. " +
        "Use the Twitch VOD or the campaign's files instead, or pass --allow-youtube if you have the rights.",
    );
  }
  const section = from !== undefined || to !== undefined ? { from: from ?? 0, to } : null;
  const vodId = twitchVodId(input);

  if (existsSync(input)) {
    const path = resolve(input);
    const slug = slugify(basename(path, extname(path))) + (section ? `-${Math.round(section.from)}` : "");
    const dir = jobDir(slug);
    const source = `${dir}source${extname(path) || ".mp4"}`;
    if (!existsSync(source)) {
      try {
        linkSync(path, source);
      } catch {
        symlinkSync(path, source);
      }
    }
    return finish({ slug, dir, source, input, kind: "file", offset: 0, section });
  }

  if (!/^https?:\/\//.test(input)) throw new Error(`"${input}" isn't a file here or a link.`);

  if (vodId) {
    const meta = await twitchVideo(vodId).catch((err) => {
      console.log(`  Twitch API: ${err.message} Carrying on without VOD details.`);
      return null;
    });
    const slug = `twitch-${vodId}${section ? `-${Math.round(section.from)}` : ""}`;
    const dir = jobDir(slug);
    const source = `${dir}source.mp4`;
    if (!existsSync(source)) {
      if (!has("yt-dlp", ["--version"])) throw new Error("Downloading Twitch VODs needs yt-dlp: brew install yt-dlp");
      const args = ["-f", "best[height<=1080]/best", "--merge-output-format", "mp4", "-o", `${dir}download.%(ext)s`, "--no-part", "--quiet", "--progress"];
      if (section) args.push("--download-sections", `*${clock(section.from)}-${section.to !== undefined ? clock(section.to) : "inf"}`, "--force-keyframes-at-cuts");
      console.log(`  Downloading Twitch VOD ${vodId}${section ? ` from ${clock(section.from)}${section.to !== undefined ? ` to ${clock(section.to)}` : ""}` : ""} with yt-dlp...`);
      execFileSync("yt-dlp", [...args, input], { stdio: "inherit" });
      renameSync(`${dir}download.mp4`, source);
    }
    return finish({ slug, dir, source, input, kind: "twitch", vodId, meta, offset: section?.from ?? 0, section: null });
  }

  // A direct link to a file, e.g. raw footage a campaign shares.
  const name = basename(new URL(input).pathname) || "video.mp4";
  const slug = slugify(basename(name, extname(name)));
  const dir = jobDir(slug);
  const source = `${dir}source${extname(name) || ".mp4"}`;
  if (!existsSync(source)) {
    console.log(`  Downloading ${name}...`);
    const res = await fetch(input);
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${input}: HTTP ${res.status}`);
    if (/text\/html/.test(res.headers.get("content-type") ?? "")) {
      throw new Error("That link is a web page, not a video file. Download the file yourself and pass its path.");
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(`${source}.part`));
    renameSync(`${source}.part`, source);
  }
  return finish({ slug, dir, source, input, kind: "url", offset: 0, section });
}

// `offset`: where source.mp4 starts in the original VOD, so Twitch clips and chat
// (which use VOD time) line up. `section`: for local files, the part to look at.
function finish(job) {
  const info = probe(job.source);
  if (!info.width) throw new Error(`${job.source} has no video track.`);
  const window = job.section
    ? { start: job.section.from, end: Math.min(info.duration, job.section.to ?? info.duration) }
    : { start: 0, end: info.duration };
  const out = { ...job, ...info, window };
  writeFileSync(`${job.dir}job.json`, `${JSON.stringify({ ...out, createdAt: new Date().toISOString() }, null, 2)}\n`);
  return out;
}
