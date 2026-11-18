// Transcript with word timings, for ranking, hooks and captions. Whisper
// (whisper.cpp, free, on this machine) runs only on the candidate windows, so an
// 8-hour VOD costs minutes, not hours. Or pass --transcript with an .srt, .vtt or
// words .json you already have.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadEnv } from "./env.mjs";
import { MEDIA, ffmpeg, has } from "./util.mjs";

const MODEL_NAME = "ggml-large-v3-turbo-q5_0.bin";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;
const CACHE_DIR = `${MEDIA}.cache/whisper/`;

export const whisperInstalled = () => has("whisper-cli", ["--help"]);

async function modelPath() {
  const env = loadEnv();
  if (env.WHISPER_MODEL) {
    if (!existsSync(env.WHISPER_MODEL)) throw new Error(`WHISPER_MODEL points at ${env.WHISPER_MODEL}, which doesn't exist.`);
    return env.WHISPER_MODEL;
  }
  const path = join(CACHE_DIR, MODEL_NAME);
  if (existsSync(path)) return path;
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`  Downloading Whisper's speech model once (${MODEL_NAME}, 574 MB)...`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Couldn't download the Whisper model: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${path}.part`));
  renameSync(`${path}.part`, path);
  return path;
}

// Words [{ text, start, end }] said between start and end of the source, in source seconds.
async function whisperWindow(source, start, end, model, hint) {
  const key = createHash("sha256").update(`${source}|${start}|${end}|${basename(model)}`).digest("hex").slice(0, 16);
  const cached = join(CACHE_DIR, `${key}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const work = join(tmpdir(), `clipper-whisper-${process.pid}-${key}`);
  mkdirSync(work, { recursive: true });
  try {
    const wav = join(work, "audio.wav");
    ffmpeg(["-ss", String(start), "-t", String(end - start), "-i", source, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const args = ["-m", model, "-f", wav, "-l", "en", "-t", "8", "-ml", "1", "-sow", "-oj", "-of", join(work, "out"), "-np"];
    if (hint) args.push("--prompt", hint);
    execFileSync("whisper-cli", args, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 28 });
    const raw = JSON.parse(readFileSync(join(work, "out.json"), "utf8"));
    const words = raw.transcription
      .map((s) => ({ text: s.text.trim(), start: start + s.offsets.from / 1000, end: start + s.offsets.to / 1000 }))
      .filter((w) => w.text && !/^\[.*\]$|^\(.*\)$/.test(w.text));
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, JSON.stringify(words));
    return words;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Adds .words to each candidate. Returns how the words were found.
export async function transcribeCandidates(job, list, { transcriptFile, hint } = {}) {
  if (transcriptFile) {
    const all = readTranscript(transcriptFile);
    for (const c of list) c.words = all.filter((w) => w.end > c.start && w.start < c.end);
    return `from ${basename(transcriptFile)}`;
  }
  if (!whisperInstalled()) {
    for (const c of list) c.words = [];
    return "skipped: Whisper isn't installed (brew install whisper-cpp), so clips get no captions";
  }
  const model = await modelPath();
  const started = Date.now();
  for (const [k, c] of list.entries()) {
    process.stdout.write(`\r  Transcribing moment ${k + 1} of ${list.length}...`);
    c.words = await whisperWindow(job.source, c.start, c.end, model, hint);
  }
  process.stdout.write("\n");
  return `Whisper, ${Math.round((Date.now() - started) / 1000)} s`;
}

// ---- Importing transcripts ---------------------------------------------------

const stamp = (s) => {
  const m = s.trim().replace(",", ".").match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) throw new Error(`Couldn't read the time "${s}".`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};

export function readTranscript(path) {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  if (/\.json$/i.test(path)) {
    const doc = JSON.parse(text);
    const words = Array.isArray(doc) ? doc : doc.words ?? doc.transcription;
    return words.map((w) => ({ text: String(w.text ?? w.word).trim(), start: Number(w.start), end: Number(w.end) })).filter((w) => w.text);
  }
  // SRT or VTT: spread each cue's time over its words by length.
  const words = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing === -1) continue;
    const [a, b] = lines[timing].split("-->").map((s) => s.trim().split(/\s+/)[0]);
    const [start, end] = [stamp(a), stamp(b)];
    const said = lines.slice(timing + 1).join(" ").replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean);
    const chars = said.reduce((n, w) => n + w.length + 1, 0);
    let t = start;
    for (const w of said) {
      const d = ((end - start) * (w.length + 1)) / chars;
      words.push({ text: w, start: t, end: t + d });
      t += d;
    }
  }
  if (!words.length) throw new Error(`${path}: no captions found. Use an .srt, .vtt or a words .json.`);
  return words;
}
