// Merges the signals into one score per 10-second bucket, and turns the peaks into
// candidate windows for transcription and ranking.

export const BUCKET = 10;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// How unusual each value is next to the rest of the stream: a robust z-score
// (median and MAD, so one huge spike doesn't flatten the others), floored at 0
// because quiet stretches shouldn't count against a moment, and capped.
export function robustZ(values) {
  if (!values.length) return [];
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med))) * 1.4826;
  const spread = mad || (Math.max(...values) - Math.min(...values)) / 4 || 1;
  return values.map((v) => Math.min(6, Math.max(0, (v - med) / spread)));
}

const WEIGHTS = { clips: 1.3, chat: 1.0, hype: 0.6, loud: 0.5, jump: 0.4 };

/**
 * @param window  { start, end } seconds of source to score
 * @param loud    [{ t, db }] per second
 * @param chat    Map bucket -> { chatters, hype, clipCalls } (source time)
 * @param clips   [{ at, duration, views }] (source time)
 * @returns [{ i, t, score, parts }] one per bucket
 */
export function scoreBuckets({ window, loud = [], chat = null, clips = [] }) {
  const first = Math.floor(window.start / BUCKET);
  const last = Math.max(first, Math.ceil(window.end / BUCKET) - 1);
  const rows = [];
  for (let i = first; i <= last; i++) rows.push({ i, t: i * BUCKET, raw: {} });
  const at = (t) => rows[Math.floor(t / BUCKET) - first];

  // Loudness: the loudest 3 seconds of each bucket, and how much louder that is
  // than the 30 seconds before (a sudden scream beats a loud stretch).
  if (loud.length) {
    const per = new Map();
    for (const s of loud) {
      const r = at(s.t);
      if (!r) continue;
      if (!per.has(r.i)) per.set(r.i, []);
      per.get(r.i).push(s.db);
    }
    for (const r of rows) {
      const dbs = (per.get(r.i) ?? [-90]).sort((a, b) => b - a).slice(0, 3);
      r.raw.loud = dbs.reduce((a, b) => a + b, 0) / dbs.length;
    }
    rows.forEach((r, k) => {
      const before = rows.slice(Math.max(0, k - 3), k).map((p) => p.raw.loud);
      r.raw.jump = before.length ? Math.max(0, r.raw.loud - Math.max(...before)) : 0;
    });
  }
  if (chat) {
    for (const r of rows) {
      const b = chat.get(r.i);
      r.raw.chat = b?.chatters ?? 0;
      r.raw.hype = (b?.hype ?? 0) + 3 * (b?.clipCalls ?? 0);
    }
  }
  if (clips.length) {
    for (const r of rows) r.raw.clips = 0;
    for (const c of clips) {
      // A clip covers the moment; weight by how many people watched it.
      const weight = 1 + Math.log10(1 + (c.views ?? 0));
      for (let t = c.at; t < c.at + (c.duration ?? 30); t += BUCKET) {
        const r = at(t);
        if (r) r.raw.clips += weight;
      }
    }
  }

  const names = Object.keys(WEIGHTS).filter((k) => rows.some((r) => k in r.raw));
  const z = Object.fromEntries(names.map((k) => [k, robustZ(rows.map((r) => r.raw[k]))]));
  const total = names.reduce((a, k) => a + WEIGHTS[k], 0) || 1;
  return rows.map((r, k) => {
    const parts = Object.fromEntries(names.map((n) => [n, Math.round(z[n][k] * 100) / 100]));
    const score = names.reduce((a, n) => a + WEIGHTS[n] * z[n][k], 0) / total;
    return { i: r.i, t: r.t, score: Math.round(score * 1000) / 1000, parts, raw: r.raw };
  });
}

/**
 * The best peaks, at least `gap` seconds apart, each as a window running `before`
 * seconds ahead of the peak and `after` past it (the setup matters as much as the payoff).
 */
export function candidates(buckets, { count = 12, gap = 90, before = 45, after = 25, window }) {
  const smoothed = buckets.map((b, k) => ({
    ...b,
    // A moment usually spans two buckets; a little smoothing finds its middle.
    smooth: b.score * 0.6 + ((buckets[k - 1]?.score ?? 0) + (buckets[k + 1]?.score ?? 0)) * 0.2,
  }));
  const picked = [];
  for (const b of [...smoothed].sort((x, y) => y.smooth - x.smooth)) {
    if (picked.length >= count) break;
    if (b.smooth <= 0 && picked.length) break;
    const peak = b.t + BUCKET / 2;
    if (picked.some((p) => Math.abs(p.peak - peak) < gap)) continue;
    const start = Math.max(window.start, peak - before);
    const end = Math.min(window.end, peak + after);
    if (end - start < 10) continue;
    picked.push({ peak, start, end, score: Math.round(b.smooth * 1000) / 1000, parts: b.parts });
  }
  return picked.map((c, k) => ({ id: k + 1, ...c }));
}
