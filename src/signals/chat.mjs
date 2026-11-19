// Chat replay: unique chatters per bucket, not messages, so sub trains, copypasta
// and bots don't fake hype. Reads a file you export, since Twitch has no official
// chat-replay API:
//   - TwitchDownloader (TwitchDownloaderCLI chatdownload --id <vod> -o chat.json)
//   - yt-dlp's live_chat.json for a YouTube stream you have rights to
//   - a simple JSON array or JSONL of { t, user, text }
import { readFileSync } from "node:fs";

// Words viewers type when something just happened. "clip" is the strongest one.
const HYPE = /\b(clip(\s?it|\s?that)?|no\s?way|omg|holy|lmao+|lul|kekw|omegalul|pog(gers|champ)?|w+|l+|wtf|bro+)\b/i;
const CLIP = /\bclip\b/i;

export function readChat(path) {
  const text = readFileSync(path, "utf8").trim();
  let messages;
  if (text.startsWith("{") && !text.includes("\n{")) messages = fromTwitchDownloader(JSON.parse(text));
  else if (text.startsWith("[")) messages = fromSimple(JSON.parse(text));
  else messages = fromJsonLines(text);
  messages = messages.filter((m) => Number.isFinite(m.t) && m.user);
  if (!messages.length) throw new Error(`${path}: found no chat messages with a time and a user. Is it a chat export?`);
  return messages.sort((a, b) => a.t - b.t);
}

function fromTwitchDownloader(doc) {
  if (!Array.isArray(doc.comments)) return fromSimple([doc]);
  return doc.comments.map((c) => ({
    t: Number(c.content_offset_seconds),
    user: c.commenter?._id ?? c.commenter?.name ?? c.commenter?.display_name,
    text: c.message?.body ?? "",
  }));
}

function fromSimple(list) {
  return list.map((m) => ({ t: Number(m.t ?? m.time ?? m.offset), user: String(m.user ?? m.author ?? ""), text: String(m.text ?? m.message ?? "") }));
}

function fromJsonLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const replay = row.replayChatItemAction;
    if (!replay) {
      out.push(...fromSimple([row]));
      continue;
    }
    const t = Number(replay.videoOffsetTimeMsec) / 1000;
    for (const action of replay.actions ?? []) {
      const item = action.addChatItemAction?.item;
      const msg = item?.liveChatTextMessageRenderer ?? item?.liveChatPaidMessageRenderer;
      if (!msg) continue;
      out.push({ t, user: msg.authorExternalChannelId, text: (msg.message?.runs ?? []).map((r) => r.text ?? r.emoji?.shortcuts?.[0] ?? "").join("") });
    }
  }
  return out;
}

// Per bucket: unique chatters, unique chatters typing hype words, and "clip" calls.
// Chat reacts a few seconds after the moment, so times move back by `lag`.
export function chatBuckets(messages, { bucket = 10, lag = 6 } = {}) {
  const buckets = new Map();
  for (const m of messages) {
    if (m.t - lag < 0) continue;
    const i = Math.floor((m.t - lag) / bucket);
    if (!buckets.has(i)) buckets.set(i, { users: new Set(), hype: new Set(), clip: new Set() });
    const b = buckets.get(i);
    b.users.add(m.user);
    if (HYPE.test(m.text)) b.hype.add(m.user);
    if (CLIP.test(m.text)) b.clip.add(m.user);
  }
  return new Map([...buckets].map(([i, b]) => [i, { chatters: b.users.size, hype: b.hype.size, clipCalls: b.clip.size }]));
}
