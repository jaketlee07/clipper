// Loudness per second (RMS level in dB) from ffmpeg. Loud reactions back up chat,
// but gunfire is loud too, so it carries less weight than chat or viewer clips.
import { spawnSync } from "node:child_process";

export function loudness(source, { start = 0, end } = {}) {
  const args = ["-nostdin", "-hide_banner", "-v", "error", "-ss", String(start)];
  if (end !== undefined) args.push("-t", String(end - start));
  args.push(
    "-i", source, "-vn", "-ac", "1",
    "-af", "aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-",
  );
  const run = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`ffmpeg couldn't read the audio: ${run.stderr.trim().split("\n").at(-1)}`);
  return parseAstats(run.stdout, start);
}

// [{ t, db }] one per second, t in source seconds.
export function parseAstats(text, start = 0) {
  const out = [];
  let t = null;
  for (const line of text.split("\n")) {
    const time = line.match(/pts_time:([\d.]+)/);
    if (time) t = Number(time[1]) + start;
    const level = line.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (level && t !== null) out.push({ t, db: level[1] === "-inf" ? -90 : Math.max(-90, Number(level[1])) });
  }
  return out;
}
