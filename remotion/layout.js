// Layout geometry shared by the Remotion template (Clip.jsx) and the frame check
// (src/screen.mjs), so both agree on which part of the source ends up on screen.
export const W = 1080;
export const H = 1920;
// The no-facecam layout shows a 4:5 crop of the gameplay at this height.
export const FULL_H = 1350;

// The facecam band keeps the facecam's own shape, within limits.
export const facecamHeight = (facecam) => Math.round(Math.min(860, Math.max(560, (W * facecam.h) / facecam.w)));

// The part of `rect` (source pixels) that fills a bandW x bandH band, cropping
// whatever doesn't fit around its middle.
export function visibleRect(rect, bandW, bandH, zoom = 1) {
  const scale = Math.max(bandW / rect.w, bandH / rect.h) * zoom;
  const [w, h] = [bandW / scale, bandH / scale];
  return { x: rect.x + rect.w / 2 - w / 2, y: rect.y + rect.h / 2 - h / 2, w, h };
}

// Every part of the source the final video shows, for a layout and its boxes.
export function visibleRegions(layout, { facecam, game }) {
  if (layout === "stacked" && facecam) {
    const faceH = facecamHeight(facecam);
    return [visibleRect(facecam, W, faceH), visibleRect(game, W, H - faceH)];
  }
  return [visibleRect(game, W, FULL_H)];
}
