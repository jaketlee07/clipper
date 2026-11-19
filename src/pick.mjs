// Pick: Claude ranks the candidate moments against the campaign and returns each
// clip's cut, hook and caption. Without an API key, clips are picked by signal
// score alone, cut around the peak, with no hook.
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { ask, claudeConfigured, prompt } from "./claude.mjs";
import { clock } from "./util.mjs";

const Picks = z.object({
  clips: z.array(
    z.object({
      candidate: z.number().int(),
      start: z.number(),
      end: z.number(),
      hook: z.string(),
      caption: z.string(),
      score: z.number(),
      why: z.string(),
    }),
  ),
});

const describe = (c) => {
  const signals = Object.entries(c.parts).map(([k, v]) => `${k} ${v}`).join(", ") || "audio only";
  const lines = [];
  let line = null;
  for (const w of c.words ?? []) {
    if (!line || w.start - line.end > 1.2 || line.text.length > 90) {
      line = { start: w.start, end: w.end, text: w.text };
      lines.push(line);
    } else {
      line.text += ` ${w.text}`;
      line.end = w.end;
    }
  }
  const transcript = lines.map((l) => `  [${l.start.toFixed(1)}] ${l.text}`).join("\n") || "  (no speech)";
  return `#${c.id} window ${c.start.toFixed(1)} to ${c.end.toFixed(1)} (${clock(c.start)}), peak at ${c.peak.toFixed(1)}, signals: ${signals}\n${transcript}`;
};

// Snaps a cut to the nearest word boundary within `slack` seconds, so a clip
// never starts or ends mid-word.
function snap(t, words, edge, slack = 0.6) {
  let best = t;
  let dist = slack;
  for (const w of words) {
    const b = edge === "start" ? w.start - 0.1 : w.end + 0.15;
    if (Math.abs(b - t) < dist) [best, dist] = [b, Math.abs(b - t)];
  }
  return best;
}

// Fits a cut inside its window and the campaign's length limits.
export function fitCut(c, start, end, campaign) {
  let [s, e] = [Math.max(c.start, start), Math.min(c.end, end)];
  s = Math.max(c.start, snap(s, c.words ?? [], "start"));
  e = Math.min(c.end, snap(e, c.words ?? [], "end"));
  if (e - s > campaign.maxSeconds) e = s + campaign.maxSeconds;
  if (e - s < campaign.minSeconds) {
    const need = campaign.minSeconds - (e - s);
    const back = Math.min(need / 2, s - c.start);
    s -= back;
    e = Math.min(c.end, e + (need - back));
    if (e - s < campaign.minSeconds) s = Math.max(c.start, e - campaign.minSeconds);
  }
  return { start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 };
}

// The brief's notes, plus the rules the pick should already steer around.
function briefNotes(campaign) {
  const notes = [campaign.notes];
  if (campaign.censorCaptions) notes.push("Hooks and captions must not swear.");
  if (campaign.visualRules.length) notes.push(`On-screen rules (a frame check enforces these after you pick): ${campaign.visualRules.join(" ")}`);
  return notes.filter(Boolean).join(" ") || "none";
}

// Returns every clip Claude thinks is worth posting, best first (the frame check
// may drop some, so the caller takes the first `count` that pass). Without
// Claude, the top `count` by signal score.
export async function pickClips(list, { campaign, streamer, count }) {
  if (!list.length) return { clips: [], how: "no candidates" };
  if (!claudeConfigured()) {
    const clips = list.slice(0, count).map((c) => {
      const len = Math.min(campaign.maxSeconds, Math.max(campaign.minSeconds, 35));
      const cut = fitCut(c, c.peak - len * 0.7, c.peak + len * 0.3, campaign);
      return { candidate: c.id, ...cut, hook: "", caption: "", score: null, why: `signal score ${c.score}`, signals: c.parts };
    });
    return { clips, how: "by signal score (no ANTHROPIC_API_KEY, so no hooks)" };
  }
  const reply = await ask({
    label: "ranking moments",
    system: "You are a short-form video editor who clips livestreams for paid campaigns. You know what holds attention in the first two seconds.",
    user: prompt("pick", {
      streamer: streamer.name || campaign.streamer || "unknown",
      campaign: campaign.name,
      platforms: campaign.platforms.join(", "),
      minSeconds: String(campaign.minSeconds),
      maxSeconds: String(campaign.maxSeconds),
      notes: briefNotes(campaign),
      count: String(list.length),
      candidates: list.map(describe).join("\n\n"),
    }),
    format: betaZodOutputFormat(Picks),
  });
  const byId = new Map(list.map((c) => [c.id, c]));
  const clips = [];
  for (const p of Picks.parse(JSON.parse(reply)).clips) {
    const c = byId.get(p.candidate);
    if (!c || clips.some((x) => x.candidate === p.candidate)) continue;
    clips.push({ ...p, ...fitCut(c, p.start, p.end, campaign), hook: p.hook.trim(), caption: p.caption.trim(), signals: c.parts });
  }
  clips.sort((a, b) => b.score - a.score);
  return { clips, how: "ranked by Claude" };
}
