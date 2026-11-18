// Render: cuts each picked clip from the source with ffmpeg, then lays it out at
// 1080x1920 in Remotion (remotion/Clip.jsx): facecam over gameplay (or a blurred
// fill when there's no facecam), word-by-word captions, a 2-second hook title, the
// streamer credit and the campaign's on-screen disclosure.
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { scaleBoxes } from "./config.mjs";
import { loadEnv } from "./env.mjs";
import { ffmpeg } from "./util.mjs";

const FPS = 30;
const ENTRY = fileURLToPath(new URL("../remotion/index.jsx", import.meta.url));
const FONTS = fileURLToPath(new URL("../remotion/fonts/", import.meta.url));

// Short-form captions: up to 3 words or about 18 characters a line, breaking at
// pauses and sentence ends. Times are relative to the clip.
export function captionLines(words, offset, length) {
  const lines = [];
  let line = null;
  for (const [i, raw] of words.entries()) {
    const w = { text: raw.text, start: raw.start - offset, end: raw.end - offset };
    if (w.end <= 0 || w.start >= length) continue;
    const prev = words[i - 1];
    const sentenceEnd = prev && /[.?!]["”')]?$/.test(prev.text);
    const pause = prev && raw.start - prev.end > 0.5;
    if (!line || line.words.length >= 3 || line.chars + w.text.length > 18 || sentenceEnd || pause) {
      line = { start: Math.max(0, w.start), end: w.end, chars: 0, words: [] };
      lines.push(line);
    }
    line.words.push({ text: w.text, start: Math.max(0, w.start) });
    line.chars += w.text.length + 1;
    line.end = w.end;
  }
  return lines.map((l, i) => ({ start: l.start, end: Math.min(lines[i + 1]?.start ?? Infinity, l.end + 0.4, length), words: l.words }));
}

export async function renderClips(job, clips, { campaign, streamer, onEach } = {}) {
  const outDir = join(job.dir, "clips");
  const publicDir = join(job.dir, "render-public");
  rmSync(publicDir, { recursive: true, force: true });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(FONTS, join(publicDir, "fonts"), { recursive: true });

  // Frame-accurate cuts, so the composition plays from 0.
  for (const clip of clips) {
    clip.cutFile = `cut-${String(clip.rank).padStart(2, "0")}.mp4`;
    ffmpeg([
      "-ss", String(clip.start), "-t", String(clip.end - clip.start), "-i", job.source,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart",
      join(publicDir, clip.cutFile),
    ]);
  }

  const env = loadEnv();
  const browserExecutable = env.BROWSER_EXECUTABLE || null;
  const boxes = scaleBoxes(streamer, job.width, job.height);
  const layout = streamer.layout === "stacked" && boxes.facecam ? "stacked" : "full";
  const credit = campaign.credit || (streamer.twitch ? `twitch.tv/${streamer.twitch}` : "");
  const disclosure = campaign.disclosure.onScreen || "";

  console.log("  Bundling the Remotion template...");
  const serveUrl = await bundle({ entryPoint: ENTRY, publicDir });
  try {
    for (const clip of clips) {
      const duration = clip.end - clip.start;
      const props = {
        fps: FPS,
        duration,
        src: clip.cutFile,
        srcW: job.width,
        srcH: job.height,
        layout,
        facecam: boxes.facecam ?? null,
        game: boxes.game,
        captions: captionLines(clip.words ?? [], clip.start, duration),
        hook: clip.hook ?? "",
        credit,
        disclosure,
      };
      const composition = await selectComposition({ serveUrl, id: "Clip", inputProps: props, browserExecutable });
      const outputLocation = join(outDir, `${clip.file}.mp4`);
      const started = Date.now();
      await renderMedia({ composition, serveUrl, codec: "h264", crf: 23, outputLocation, inputProps: props, browserExecutable });
      clip.video = outputLocation;
      clip.bytes = statSync(outputLocation).size;
      clip.layout = layout;
      clip.credit = credit;
      clip.onScreenDisclosure = disclosure;
      onEach?.(clip, Math.round((Date.now() - started) / 1000));
    }
  } finally {
    rmSync(serveUrl, { recursive: true, force: true });
    if (existsSync(publicDir)) rmSync(publicDir, { recursive: true, force: true });
  }
  return outDir;
}
