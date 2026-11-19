// Screen: looks at frames of each picked clip before it's rendered, so a clip
// doesn't start or end on a menu, map, loading or black screen, doesn't show what
// the campaign's on-screen rules ban ("visualRules"), and is rendered full-frame
// when it's IRL camera footage, which has no facecam to stack. Needs
// ANTHROPIC_API_KEY; about $0.04 a clip.
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { visibleRegions } from "../remotion/layout.js";
import { ask, prompt } from "./claude.mjs";
import { scaleBoxes } from "./config.mjs";
import { ffmpeg } from "./util.mjs";

export const STEP = 2; // seconds between checked frames
const FRAME_W = 640;

const Verdicts = z.object({
  frames: z.array(z.object({ t: z.number(), scene: z.enum(["stream", "irl", "menu", "black", "other"]), problem: z.string() })),
});

// The boxes each kind of footage is rendered with: the streamer's own layout for
// stream footage, and a full-frame crop (streamer.irl.game, or the whole frame)
// for IRL.
export function layoutsFor(streamer, width, height) {
  const stream = scaleBoxes(streamer, width, height);
  const irl = scaleBoxes({ ...streamer, facecam: null, game: streamer.irl?.game }, width, height);
  return {
    stream: { layout: streamer.layout === "stacked" && stream.facecam ? "stacked" : "full", ...stream },
    irl: { layout: "full", facecam: null, game: irl.game },
  };
}

const usable = (f) => (f.scene === "stream" || f.scene === "irl") && !f.problem.trim();

// From the per-frame verdicts, the longest run of usable footage as a cut, and
// whether it's IRL. Each frame stands for the STEP seconds around it.
export function cleanCut(clip, frames, { minSeconds, step = STEP }) {
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  let best = null;
  let run = null;
  for (const [i, f] of sorted.entries()) {
    if (!usable(f)) {
      run = null;
      continue;
    }
    run ??= { first: i, last: i };
    run.last = i;
    if (!best || run.last - run.first > best.last - best.first) best = { ...run };
  }
  const notes = [];
  for (const f of sorted) {
    if (f.problem.trim()) notes.push(`${f.problem.trim()} at ${(f.t - clip.start).toFixed(0)} s`);
  }
  if (!best) return { keep: false, reason: "no usable footage (menus, black screens or rule problems throughout)", notes };

  const start = best.first === 0 ? clip.start : Math.max(clip.start, sorted[best.first].t - step / 2);
  const end = best.last === sorted.length - 1 ? clip.end : Math.min(clip.end, sorted[best.last].t + step / 2);
  const kept = sorted.slice(best.first, best.last + 1);
  const irl = kept.filter((f) => f.scene === "irl").length > kept.length / 2;
  if (end - start < minSeconds - 0.05) {
    return { keep: false, reason: `only ${(end - start).toFixed(0)} s of usable footage, under the ${minSeconds} s minimum`, notes };
  }
  const cut = [];
  if (start > clip.start + 0.05) cut.push(`${(start - clip.start).toFixed(0)} s at the start`);
  if (end < clip.end - 0.05) cut.push(`${(clip.end - end).toFixed(0)} s at the end`);
  const skipped = sorted.filter((f, i) => (i < best.first || i > best.last) && !usable(f));
  const why = [...new Set(skipped.map((f) => (f.problem.trim() ? "a rule problem" : `${f.scene} screen`)))].join(", ");
  return { keep: true, start, end, irl, trimmed: cut.length ? `trimmed ${cut.join(" and ")} (${why})` : "", notes };
}

// Moves a trimmed cut inward so it doesn't start or end partway through a word.
export function snapInward(start, end, words) {
  for (const w of words) {
    if (w.start < start && w.end > start) start = w.end + 0.05;
    if (w.start < end && w.end > end) end = w.start - 0.05;
  }
  return { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };
}

function frames(job, clip, regions) {
  const dir = join(job.dir, `screen-${clip.candidate}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const k = FRAME_W / job.width;
  const boxes = regions.map((r) => {
    const x = Math.max(0, Math.round(r.x * k));
    const y = Math.max(0, Math.round(r.y * k));
    const w = Math.min(FRAME_W - x, Math.round(r.w * k));
    const h = Math.min(Math.round(job.height * k) - y, Math.round(r.h * k));
    return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=lime@0.9:t=3`;
  });
  // One frame every STEP seconds, each in the middle of its STEP-second slot.
  ffmpeg([
    "-ss", String(clip.start + STEP / 2), "-t", String(clip.end - clip.start - STEP / 2), "-i", job.source,
    "-vf", [`fps=1/${STEP}`, `scale=${FRAME_W}:-2`, ...boxes].join(","), "-q:v", "4", join(dir, "f-%03d.jpg"),
  ]);
  const files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
  const out = files
    .map((f, i) => ({ t: Math.round((clip.start + STEP / 2 + i * STEP) * 10) / 10, data: readFileSync(join(dir, f)).toString("base64") }))
    .filter((f) => f.t < clip.end);
  rmSync(dir, { recursive: true, force: true });
  return out;
}

export async function screenClip(job, clip, { campaign, streamer }) {
  const looks = layoutsFor(streamer, job.width, job.height);
  const regions = visibleRegions(looks.stream.layout, looks.stream);
  const [irlRect] = visibleRegions("full", looks.irl);
  const pct = (n) => Math.round((n / job.width) * 100);
  const shown =
    looks.stream.layout === "stacked"
      ? `The green boxes mark what the final vertical video shows of a stream frame: the facecam box, stacked on top of the gameplay box. Everything outside them is cropped out. For an irl frame the boxes don't apply: the video shows the middle of the frame instead, from about ${pct(irlRect.x)}% to ${pct(irlRect.x + irlRect.w)}% of its width.`
      : "The green box marks what the final vertical video shows. Everything outside it is cropped out.";
  const shots = frames(job, clip, regions);
  if (!shots.length) return { keep: true, start: clip.start, end: clip.end, irl: false, trimmed: "", notes: [] };

  const content = [];
  for (const s of shots) {
    content.push({ type: "text", text: `t=${s.t}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.data } });
  }
  content.push({
    type: "text",
    text: prompt("screen", {
      seconds: String(Math.round(clip.end - clip.start)),
      streamer: streamer.name || campaign.streamer || "the streamer",
      step: String(STEP),
      campaign: campaign.name,
      shown,
      rules: campaign.visualRules.length ? campaign.visualRules.map((r) => `- ${r}`).join("\n") : "- (none beyond the scene types)",
    }),
  });
  const reply = await ask({
    label: `checking frames of #${clip.candidate}`,
    system: "You check livestream footage against a clipping campaign's rules before it's posted. You are literal and consistent.",
    user: content,
    format: betaZodOutputFormat(Verdicts),
    effort: "low",
    maxTokens: 16000,
  });
  // Match verdicts to frames by time, in case Claude skips or reorders one.
  const verdicts = Verdicts.parse(JSON.parse(reply)).frames;
  const matched = shots.map((s) => {
    const v = verdicts.reduce((best, x) => (Math.abs(x.t - s.t) < Math.abs(best.t - s.t) ? x : best), verdicts[0]);
    return { t: s.t, scene: v?.scene ?? "stream", problem: v?.problem ?? "" };
  });
  return { ...cleanCut(clip, matched, { minSeconds: campaign.minSeconds }), frames: matched };
}
