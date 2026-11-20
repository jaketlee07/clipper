// Twitch Helix (the official API): VOD details and the clips viewers made from it.
// A clip someone bothered to make, and others watched, is the strongest sign of a
// moment, and catches chases and crashes where nobody talks.
import { loadEnv } from "../env.mjs";

let token = null;

async function helix(path, params, retry = true) {
  const env = loadEnv();
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) throw new Error("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET aren't set.");
  if (!token) {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`Twitch sign-in failed (HTTP ${res.status}). Check the client ID and secret.`);
    token = (await res.json()).access_token;
  }
  const url = new URL(`https://api.twitch.tv/helix/${path}`);
  for (const [k, v] of Object.entries(params)) for (const one of [v].flat()) if (one !== undefined) url.searchParams.append(k, one);
  const res = await fetch(url, { headers: { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` } });
  // The sign-in token expires after a few weeks, which a long-running bot outlives.
  if (res.status === 401 && retry) {
    token = null;
    return helix(path, params, false);
  }
  if (!res.ok) throw new Error(`Twitch API ${path} returned HTTP ${res.status}.`);
  return res.json();
}

export const twitchConfigured = () => {
  const env = loadEnv();
  return Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
};

// "3h2m10s" -> seconds
const helixDuration = (text) => [...text.matchAll(/(\d+)([hms])/g)].reduce((acc, [, n, u]) => acc + Number(n) * { h: 3600, m: 60, s: 1 }[u], 0);

export async function twitchVideo(id) {
  if (!twitchConfigured()) return null;
  const { data } = await helix("videos", { id });
  const v = data[0];
  if (!v) throw new Error(`VOD ${id} wasn't found (deleted, or subscriber-only).`);
  return { id: v.id, userId: v.user_id, login: v.user_login, name: v.user_name, title: v.title, createdAt: v.created_at, duration: helixDuration(v.duration), url: v.url };
}

// Viewer clips from this VOD: [{ at, duration, views, title, url }] in VOD seconds.
export async function vodClips(meta) {
  if (!meta || !twitchConfigured()) return [];
  const started = new Date(meta.createdAt);
  const ended = new Date(started.getTime() + (meta.duration + 3600) * 1000);
  const clips = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const res = await helix("clips", { broadcaster_id: meta.userId, started_at: started.toISOString(), ended_at: ended.toISOString(), first: 100, after: cursor });
    for (const c of res.data) {
      if (c.video_id !== meta.id || c.vod_offset === null || c.vod_offset === undefined) continue;
      clips.push({ at: c.vod_offset, duration: c.duration, views: c.view_count, title: c.title, url: c.url });
    }
    cursor = res.pagination?.cursor;
    if (!cursor) break;
  }
  return clips;
}

// A streamer's newest past broadcasts, newest first. While they're live, the
// broadcast in progress is listed too (live: true) and its duration keeps growing.
export async function recentVods(login, count = 5) {
  const { data: users } = await helix("users", { login });
  if (!users[0]) throw new Error(`There's no Twitch user called "${login}".`);
  const [{ data: videos }, { data: streams }] = await Promise.all([
    helix("videos", { user_id: users[0].id, type: "archive", first: count }),
    helix("streams", { user_id: users[0].id }),
  ]);
  const live = streams[0] ?? null;
  const isLive = (v) =>
    Boolean(live) && (v.stream_id ? v.stream_id === live.id : Math.abs(new Date(v.created_at) - new Date(live.started_at)) < 10 * 60 * 1000);
  return videos.map((v) => ({ id: v.id, streamId: v.stream_id ?? null, title: v.title, createdAt: v.created_at, duration: helixDuration(v.duration), live: isLive(v) }));
}

// Which of these streamers are live now: Map of login -> { id, title, game, startedAt, viewers }.
export async function liveStreams(logins) {
  const live = new Map();
  for (let i = 0; i < logins.length; i += 100) {
    const { data } = await helix("streams", { user_login: logins.slice(i, i + 100), type: "live" });
    for (const s of data) live.set(s.user_login.toLowerCase(), { id: s.id, name: s.user_name, title: s.title, game: s.game_name, startedAt: s.started_at, viewers: s.viewer_count });
  }
  return live;
}
