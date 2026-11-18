// Saves a still of a VOD with a 100 px grid, to read a streamer's facecam box off
// it for streamers/<name>.json (auto-detecting the facecam fails too often).
//
//   npm run frame -- <video file> [--at 10:00]
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { ffmpeg, parseArgs, parseClock, probe } from "./util.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const file = positional[0];

try {
  if (!file || !existsSync(file)) throw new Error("Usage: npm run frame -- <video file> [--at 10:00]");
  const info = probe(file);
  const at = parseClock(flags.at) ?? Math.min(600, info.duration / 2);
  const out = join(dirname(file), `${basename(file, extname(file))}-frame-${Math.round(at)}.png`);
  ffmpeg(["-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "drawgrid=w=100:h=100:t=2:c=red@0.6", out]);
  console.log(`Saved ${out} (${info.width}x${info.height}, grid every 100 px).
Put the facecam's box in streamers/<name>.json as "facecam": { "x": left, "y": top, "w": width, "h": height },
and "sourceSize": { "w": ${info.width}, "h": ${info.height} }.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
