import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatBuckets, readChat } from "../src/signals/chat.mjs";
import { parseAstats } from "../src/signals/loudness.mjs";
import { candidates, robustZ, scoreBuckets } from "../src/signals/score.mjs";

const tmp = mkdtempSync(join(tmpdir(), "clipper-test-"));

test("robustZ ignores quiet stretches and caps spikes", () => {
  const z = robustZ([1, 1, 2, 1, 1, 40]);
  assert.equal(z[0], 0);
  assert.ok(z[5] > 3);
  assert.equal(robustZ([1, 2, 1, 2, 1, 2, 1000])[6], 6);
});

test("unique chatters, not messages: one spammer is not a spike", () => {
  const spam = Array.from({ length: 50 }, (_, i) => ({ t: 100 + i * 0.1, user: "bot", text: "CLIP IT" }));
  const crowd = Array.from({ length: 30 }, (_, i) => ({ t: 206 + i * 0.1, user: `u${i}`, text: i % 3 ? "lol" : "clip that" }));
  const b = chatBuckets([...spam, ...crowd], { lag: 6 });
  assert.equal(b.get(9).chatters, 1);
  assert.equal(b.get(20).chatters, 30);
  assert.equal(b.get(20).clipCalls, 10);
});

test("reads TwitchDownloader, yt-dlp live chat and simple exports", () => {
  const td = join(tmp, "td.json");
  writeFileSync(td, JSON.stringify({ comments: [{ content_offset_seconds: 12.5, commenter: { _id: "1" }, message: { body: "W" } }] }));
  assert.deepEqual(readChat(td), [{ t: 12.5, user: "1", text: "W" }]);

  const yt = join(tmp, "live_chat.json");
  const line = { replayChatItemAction: { videoOffsetTimeMsec: "4000", actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { authorExternalChannelId: "UC1", message: { runs: [{ text: "no way" }] } } } } }] } };
  writeFileSync(yt, `${JSON.stringify(line)}\n${JSON.stringify(line)}\n`);
  assert.equal(readChat(yt).length, 2);
  assert.equal(readChat(yt)[0].t, 4);

  const simple = join(tmp, "simple.json");
  writeFileSync(simple, JSON.stringify([{ t: 3, user: "a", text: "x" }]));
  assert.equal(readChat(simple)[0].user, "a");
});

test("parses ffmpeg astats output", () => {
  const text = "frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.RMS_level=-40.5\nframe:1    pts:8000    pts_time:1\nlavfi.astats.Overall.RMS_level=-inf\n";
  assert.deepEqual(parseAstats(text, 10), [{ t: 10, db: -40.5 }, { t: 11, db: -90 }]);
});

test("the chat spike and the viewer clip become the top candidates, spaced apart", () => {
  const window = { start: 0, end: 600 };
  const loud = Array.from({ length: 600 }, (_, t) => ({ t, db: t >= 300 && t < 305 ? -8 : -40 }));
  const chat = new Map(Array.from({ length: 60 }, (_, i) => [i, { chatters: i === 45 ? 80 : 5, hype: 0, clipCalls: 0 }]));
  const clips = [{ at: 120, duration: 30, views: 5000 }];
  const buckets = scoreBuckets({ window, loud, chat, clips });
  const list = candidates(buckets, { count: 3, gap: 90, window });
  const peaks = list.map((c) => c.peak);
  assert.ok(peaks.some((p) => p >= 450 && p <= 460), `chat spike in ${peaks}`);
  assert.ok(peaks.some((p) => p >= 120 && p <= 150), `viewer clip in ${peaks}`);
  for (const a of peaks) for (const b of peaks) if (a !== b) assert.ok(Math.abs(a - b) >= 90);
  for (const c of list) assert.ok(c.start >= 0 && c.end <= 600 && c.start < c.peak && c.peak < c.end);
});
