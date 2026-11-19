import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MEDIA = fileURLToPath(new URL("../media/", import.meta.url));

export function jobDir(slug) {
  const dir = `${MEDIA}${slug}/`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const slugify = (text) =>
  text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "clip";

// 754.2 -> "12:34", 4000 -> "1:06:40"
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// "1:02:03" / "62:03" / "3723" -> seconds
export function parseClock(text) {
  if (text === undefined || text === null || text === "") return undefined;
  const parts = String(text).split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) throw new Error(`"${text}" isn't a time. Use 1:02:03, 62:03 or 3723.`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function has(command, probe = ["-version"]) {
  return spawnSync(command, probe, { stdio: "ignore" }).status === 0;
}

export function ffmpeg(args, opts = {}) {
  return execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-y", ...args], { maxBuffer: 1 << 28, ...opts });
}

export function probe(path) {
  const out = execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8" });
  const info = JSON.parse(out);
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  return {
    duration: Number(info.format.duration),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: Boolean(audio),
  };
}

// Minimal flag parser: --key value, --flag, --no-flag; everything else is positional.
export function parseArgs(argv, booleans = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    if (name.startsWith("no-")) flags[name.slice(3)] = false;
    else if (inline !== undefined) flags[name] = inline;
    else if (booleans.includes(name) || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { flags, positional };
}
