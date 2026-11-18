import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (dir) => fileURLToPath(new URL(`../${dir}/`, import.meta.url));

function load(dir, name, what) {
  const path = `${root(dir)}${name}.json`;
  if (!existsSync(path)) throw new Error(`No ${what} called "${name}". Create ${dir}/${name}.json (copy ${dir}/example.json).`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const CAMPAIGN_DEFAULTS = {
  platforms: ["tiktok", "youtube", "instagram"],
  minSeconds: 15,
  maxSeconds: 60,
  clipsPerVod: 5,
  hashtags: [],
  mentions: [],
  captionMustInclude: [],
  bannedWords: [],
  disclosure: { caption: "", onScreen: "" },
  credit: "",
  notes: "",
};

export function loadCampaign(name) {
  const c = { ...CAMPAIGN_DEFAULTS, ...load("campaigns", name, "campaign"), id: name };
  c.disclosure = { ...CAMPAIGN_DEFAULTS.disclosure, ...c.disclosure };
  if (c.minSeconds > c.maxSeconds) throw new Error(`campaigns/${name}.json: minSeconds is more than maxSeconds.`);
  return c;
}

export function loadStreamer(name) {
  if (!name) return { name: "", layout: "full" };
  const s = load("streamers", name, "streamer");
  if (s.layout === "stacked" && !s.facecam) throw new Error(`streamers/${name}.json uses the stacked layout but has no facecam box.`);
  return { layout: s.facecam ? "stacked" : "full", ...s, id: name };
}

// A streamer's boxes in pixels of this VOD, which may not be the size they were measured on.
export function scaleBoxes(streamer, width, height) {
  const from = streamer.sourceSize ?? { w: width, h: height };
  const [sx, sy] = [width / from.w, height / from.h];
  const scale = (b) => b && { x: Math.round(b.x * sx), y: Math.round(b.y * sy), w: Math.round(b.w * sx), h: Math.round(b.h * sy) };
  return { facecam: scale(streamer.facecam), game: scale(streamer.game) ?? { x: 0, y: 0, w: width, h: height } };
}
