// Lint: checks each clip against its campaign's rules before anyone posts it, and
// fixes what can be fixed safely (adding the required hashtags, mentions and
// disclosure to the caption, starring out swearing). Errors mean "don't post
// this as is".
import { censorFor } from "./censor.mjs";

const words = (text) => text.toLowerCase();

export function finalCaption(clip, campaign) {
  const parts = [clip.caption?.trim()].filter(Boolean);
  const body = () => words(parts.join(" "));
  for (const need of campaign.captionMustInclude) if (!body().includes(words(need))) parts.push(need);
  for (const m of campaign.mentions) if (!body().includes(words(m))) parts.push(m);
  if (campaign.disclosure.caption && !body().includes(words(campaign.disclosure.caption))) parts.push(campaign.disclosure.caption);
  const tags = campaign.hashtags.filter((t) => !body().includes(words(t)));
  return censorFor(campaign)([...parts, ...tags].join(" ").replace(/\s+/g, " ").trim());
}

export function lintClip(clip, campaign) {
  const errors = [];
  const warnings = [];
  const length = clip.end - clip.start;
  if (length < campaign.minSeconds - 0.05) errors.push(`${length.toFixed(1)} s is shorter than the ${campaign.minSeconds} s minimum`);
  if (length > campaign.maxSeconds + 0.05) errors.push(`${length.toFixed(1)} s is longer than the ${campaign.maxSeconds} s maximum`);

  const caption = clip.finalCaption ?? finalCaption(clip, campaign);
  for (const tag of campaign.hashtags) if (!words(caption).includes(words(tag))) errors.push(`caption is missing ${tag}`);
  for (const need of campaign.captionMustInclude) if (!words(caption).includes(words(need))) errors.push(`caption is missing "${need}"`);
  if (campaign.disclosure.caption && !words(caption).includes(words(campaign.disclosure.caption))) errors.push(`caption is missing the disclosure "${campaign.disclosure.caption}"`);
  // Only a rendered clip can be checked for what's on screen.
  if (clip.video) {
    if (campaign.disclosure.onScreen && !clip.onScreenDisclosure) errors.push("the on-screen disclosure isn't in the video");
    if (campaign.credit && !clip.credit) errors.push("the streamer credit isn't in the video");
  }

  // TikTok's caption limit is the tightest of the three platforms that matter here.
  if (caption.length > 2200) errors.push(`caption is ${caption.length} characters; TikTok allows 2,200`);
  if ((caption.match(/#\w+/g) ?? []).length > 5) warnings.push("more than 5 hashtags can read as spam on Instagram");

  const said = (clip.words ?? []).map((w) => w.text).join(" ");
  for (const banned of campaign.bannedWords) {
    const re = new RegExp(`\\b${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(clip.hook ?? "") || re.test(caption)) errors.push(`hook or caption uses the banned word "${banned}"`);
    else if (re.test(said)) warnings.push(`the streamer says "${banned}" in the clip`);
  }
  if (!clip.hook) warnings.push("no hook title");
  else if (clip.hook.split(/\s+/).length > 8) warnings.push("hook is longer than 8 words");
  if (!(clip.words ?? []).length) warnings.push("no captions (no speech found, or Whisper is off)");
  for (const note of clip.checkNotes ?? []) warnings.push(note);

  return { ok: errors.length === 0, errors, warnings, caption };
}
