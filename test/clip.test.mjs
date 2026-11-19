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
