import { continueRender, delayRender, staticFile } from "remotion";

// Montserrat (SIL Open Font License, remotion/fonts/OFL.txt), shipped with the repo
// and copied into each render, so rendering needs no network.
export const font = "Montserrat";
if (typeof FontFace !== "undefined" && typeof document !== "undefined") {
  const handle = delayRender("Loading Montserrat");
  const face = new FontFace(font, `url(${staticFile("fonts/Montserrat-latin.woff2")}) format("woff2")`, { weight: "100 900" });
  face
    .load()
    .then((loaded) => document.fonts.add(loaded))
    .catch((err) => console.warn(`Montserrat didn't load, using a fallback font: ${err.message}`))
    .finally(() => continueRender(handle));
}

export const colors = {
  text: "#FFFFFF",
  highlight: "#FFE14D",
  stroke: "#000000",
  pill: "rgba(0, 0, 0, 0.55)",
};

// TikTok, Reels and Shorts draw their buttons and caption over the bottom ~22%
// and the right edge, so nothing important goes there.
export const SAFE = { bottom: 1500, right: 940 };
