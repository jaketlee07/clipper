import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scaleBoxes } from "../src/config.mjs";
import { finalCaption, lintClip } from "../src/lint.mjs";
import { fitCut } from "../src/pick.mjs";
import { captionLines } from "../src/render.mjs";
import { readTranscript } from "../src/transcript.mjs";
import { parseArgs, parseClock } from "../src/util.mjs";

const campaign = {
  minSeconds: 15,
  maxSeconds: 60,
  hashtags: ["#gta6", "#tomo"],
  mentions: ["@tomo"],
  captionMustInclude: [],
  bannedWords: ["sponsor"],
  disclosure: { caption: "#ad", onScreen: "Paid partnership" },
  credit: "twitch.tv/tomo",
};

test("cuts stay inside the window and the length limits, on word boundaries", () => {
  const c = { start: 100, end: 170, words: [{ text: "no", start: 120.2, end: 120.5 }, { text: "way", start: 150.0, end: 150.4 }] };
  assert.deepEqual(fitCut(c, 120.4, 150.2, campaign), { start: 120.1, end: 150.55 });
  const long = fitCut(c, 90, 200, campaign);
  assert.ok(long.start >= 100 && long.end - long.start <= 60);
  const short = fitCut(c, 140, 145, campaign);
  assert.ok(short.end - short.start >= 15 - 1e-9);
});

test("caption gets the required tags, mention and disclosure added once", () => {
  const caption = finalCaption({ caption: "He did not see that coming #GTA6" }, campaign);
  assert.equal(caption, "He did not see that coming #GTA6 @tomo #ad #tomo");
});

test("lint flags missing on-screen disclosure, credit, length and banned words", () => {
  const bad = lintClip({ start: 0, end: 70, hook: "Sponsor time", caption: "x", words: [], video: "a.mp4" }, campaign);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("longer")));
  assert.ok(bad.errors.some((e) => e.includes("on-screen disclosure")));
  assert.ok(bad.errors.some((e) => e.includes("credit")));
  assert.ok(bad.errors.some((e) => e.includes("sponsor")));
  const good = lintClip({ start: 0, end: 30, hook: "He actually did it", caption: "wow", words: [{ text: "hi", start: 1, end: 2 }], onScreenDisclosure: "Paid partnership", credit: "twitch.tv/tomo", video: "a.mp4" }, campaign);
  assert.deepEqual(good.errors, []);
});

test("captions: three words or fewer a line, relative to the clip", () => {
  const words = ["one", "two", "three", "four.", "Five"].map((text, i) => ({ text, start: 10 + i * 0.3, end: 10.25 + i * 0.3 }));
  const lines = captionLines(words, 10, 20);
  assert.deepEqual(lines.map((l) => l.words.map((w) => w.text)), [["one", "two", "three"], ["four."], ["Five"]]);
  assert.equal(lines[0].start, 0);
});

test("reads SRT into timed words", () => {
  const dir = mkdtempSync(join(tmpdir(), "clipper-srt-"));
  const path = join(dir, "a.srt");
  writeFileSync(path, "1\n00:01:00,000 --> 00:01:02,000\nhello there\n\n2\n00:01:03,000 --> 00:01:04,000\n<i>bye</i>\n");
  const words = readTranscript(path);
  assert.deepEqual(words.map((w) => w.text), ["hello", "there", "bye"]);
  assert.equal(words[0].start, 60);
  assert.ok(Math.abs(words[1].end - 62) < 1e-9);
});

test("facecam boxes scale to the VOD's size", () => {
  const s = { facecam: { x: 1500, y: 40, w: 380, h: 290 }, sourceSize: { w: 1920, h: 1080 } };
  assert.deepEqual(scaleBoxes(s, 1280, 720).facecam, { x: 1000, y: 27, w: 253, h: 193 });
});

test("args and times", () => {
  assert.equal(parseClock("1:02:03"), 3723);
  assert.equal(parseClock("90"), 90);
  const { flags, positional } = parseArgs(["vod.mp4", "--campaign", "tomo", "--no-render", "--from=10:00"]);
  assert.deepEqual(positional, ["vod.mp4"]);
  assert.deepEqual(flags, { campaign: "tomo", render: false, from: "10:00" });
});

test("censor stars swearing only for campaigns that ask, and leaves look-alikes", async () => {
  const { censorFor } = await import("../src/censor.mjs");
  const on = censorFor({ censorCaptions: true, censorWords: ["crap"] });
  assert.equal(on("SHIT and I, what the fuckin' hell"), "SH*T and I, what the f*ckin' hell");
  assert.equal(on("motherfucker bullshit dumbass asshole crap!"), "motherf*cker bullsh*t dumba** a**hole c**p!");
  assert.equal(on("peacock cocktail Dickens shitake"), "peacock cocktail Dickens shitake");
  assert.equal(censorFor({ censorCaptions: false })("shit"), "shit");
  const caption = finalCaption({ caption: "LACY lost his shit" }, { ...campaign, censorCaptions: true, censorWords: [] });
  assert.ok(caption.startsWith("LACY lost his sh*t"));
});

test("frame check keeps the longest usable run and trims menus off the ends", async () => {
  const { cleanCut, snapInward } = await import("../src/screen.mjs");
  const clip = { start: 100, end: 140 };
  const f = (t, scene, problem = "") => ({ t, scene, problem });
  // Menu for the first 6 s, then gameplay to the end.
  const frames = [f(101, "menu"), f(103, "menu"), f(105, "menu", "radio station logos"), ...[107, 109, 111, 113, 115, 117, 119, 121, 123, 125, 127, 129, 131, 133, 135, 137, 139].map((t) => f(t, "stream"))];
  const cut = cleanCut(clip, frames, { minSeconds: 15 });
  assert.equal(cut.keep, true);
  assert.equal(cut.start, 106);
  assert.equal(cut.end, 140);
  assert.equal(cut.irl, false);
  assert.match(cut.trimmed, /6 s at the start/);
  // All IRL: kept whole, flagged for the full-frame layout.
  const irl = cleanCut(clip, [101, 103, 105, 107, 109, 111, 113, 115, 117, 119].map((t) => f(t, "irl")), { minSeconds: 15 });
  assert.deepEqual([irl.start, irl.end, irl.irl, irl.trimmed], [100, 140, true, ""]);
  // Too little usable footage left: dropped.
  const short = cleanCut(clip, [f(101, "stream"), f(103, "stream"), f(105, "black"), f(107, "menu")], { minSeconds: 15 });
  assert.equal(short.keep, false);
  // Trimmed edges move inward off a word rather than cutting it in half.
  assert.deepEqual(snapInward(106, 140, [{ start: 105.5, end: 106.4 }, { start: 139.8, end: 140.3 }]), { start: 106.45, end: 139.75 });
});

test("the frame check and the template agree on what's on screen", async () => {
  const { visibleRegions } = await import("../remotion/layout.js");
  const [face, game] = visibleRegions("stacked", { facecam: { x: 0, y: 0, w: 494, h: 278 }, game: { x: 500, y: 0, w: 860, h: 1080 } });
  assert.ok(Math.abs(face.x) < 1 && Math.abs(face.w - 494) < 1 && face.h === 278);
  // Lacy's gameplay band shows x 500 to 1360 of the source, so his chat (from x 1370) is cropped out.
  assert.ok(game.x >= 500 && game.x + game.w <= 1360);
  const [full] = visibleRegions("full", { game: { x: 0, y: 0, w: 1920, h: 1080 } });
  assert.equal(Math.round(full.w), 864);
});

test("follow takes full chunks of a live VOD, overlapping a little, and the tail of a finished one", async () => {
  const { nextChunk } = await import("../src/follow.mjs");
  const opts = { chunk: 1800, minSeconds: 15 };
  // Live at 1:00:00: the VOD runs 3 minutes behind, so only one full chunk from 0 is ready.
  assert.deepEqual(nextChunk({ live: true, duration: 3600 }, 0, opts), { from: 0, to: 1800 });
  assert.equal(nextChunk({ live: true, duration: 3600 }, 1800, opts), null);
  // Later chunks start a minute early, so a moment on the boundary isn't cut.
  assert.deepEqual(nextChunk({ live: true, duration: 5600 }, 1800, opts), { from: 1740, to: 3600 });
  // Once the broadcast is over, the last stretch is taken even if it's short.
  assert.deepEqual(nextChunk({ live: false, duration: 4000 }, 3600, opts), { from: 3540, to: 4000 });
  assert.equal(nextChunk({ live: false, duration: 3610 }, 3600, opts), null);
});

test("following starts at most the backlog back into the live broadcast, and leaves old ones alone", async () => {
  const { startState, isRecordingOf } = await import("../src/follow.mjs");
  assert.deepEqual(startState({ live: true, duration: 3 * 3600 }, undefined, 3600), { done: 2 * 3600 });
  // Stopped two hours ago: picks up an hour back, not where it stopped.
  assert.deepEqual(startState({ live: true, duration: 5 * 3600 }, { done: 3 * 3600 }, 3600), { done: 4 * 3600 });
  // Stopped ten minutes ago: picks up where it stopped.
  assert.deepEqual(startState({ live: true, duration: 5 * 3600 }, { done: 5 * 3600 - 600 }, 3600), { done: 5 * 3600 - 600 });
  // A broadcast that was being followed finishes its tail; one that wasn't is skipped.
  assert.deepEqual(startState({ live: false, duration: 7200 }, { done: 6000 }, 3600), { done: 6000 });
  assert.equal(startState({ live: false, duration: 7200 }, undefined, 3600).finished, true);
  assert.equal(isRecordingOf({ streamId: "42" }, { id: "42" }), true);
  assert.equal(isRecordingOf({ streamId: "41" }, { id: "42" }), false);
  assert.equal(isRecordingOf({ streamId: null, createdAt: "2026-11-20T10:01:00Z" }, { id: "42", startedAt: "2026-11-20T10:00:00Z" }), true);
});

test("the bot's message offers the right buttons for each stage", async () => {
  const { view } = await import("../src/bot.mjs");
  const rec = { id: "s1", name: "LACY", title: "GTA 6 MARATHON", game: "Grand Theft Auto VI" };
  const camp = { id: "lacy-gta", name: "LACY GTA VI" };
  const ids = (v) => v.buttons.map((b) => b[0].split("|")[0]);
  const asked = view(rec, camp, { status: "asked" }, { owner: "99", live: true });
  assert.match(asked.content, /LACY is live.*GTA 6 MARATHON \(Grand Theft Auto VI\)[\s\S]*<@99>/);
  assert.deepEqual(ids(asked), ["start", "skip"]);
  assert.equal(asked.buttons[0][0], "start|s1|lacy-gta");
  const following = view(rec, camp, { status: "following", since: "2026-11-20T10:00:00Z", chunks: 2, clips: 5, now: "1:00:00 to 1:30:00" }, { live: true });
  assert.match(following.content, /2 chunks done, 5 clips so far.*Now clipping 1:00:00 to 1:30:00/);
  assert.deepEqual(ids(following), ["stop"]);
  assert.deepEqual(ids(view(rec, camp, { status: "stopped", stoppedAt: "2026-11-20T11:00:00Z" }, { live: true })), ["start"]);
  assert.deepEqual(ids(view(rec, camp, { status: "stopped", stoppedAt: "2026-11-20T11:00:00Z" }, { live: false })), []);
  assert.deepEqual(ids(view(rec, camp, { status: "ended" }, { live: false })), []);
  assert.match(view(rec, camp, { status: "done", chunks: 1, clips: 1 }, { live: false }).content, /1 chunk done, 1 clip\./);
});
