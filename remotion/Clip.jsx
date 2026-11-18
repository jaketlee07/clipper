import { Video } from "@remotion/media";
import { AbsoluteFill, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Captions } from "./Captions.jsx";
import { SAFE, colors, font } from "./theme.js";

const W = 1080;
const H = 1920;

// Shows the `rect` part of the source video filling a band of bandW x bandH,
// cropping whatever doesn't fit. `zoom` pushes in around the middle.
function Crop({ src, srcW, srcH, rect, bandW, bandH, zoom = 1, muted, style }) {
  const scale = Math.max(bandW / rect.w, bandH / rect.h) * zoom;
  const left = bandW / 2 - (rect.x + rect.w / 2) * scale;
  const top = bandH / 2 - (rect.y + rect.h / 2) * scale;
  return (
    <div style={{ position: "absolute", width: bandW, height: bandH, overflow: "hidden", ...style }}>
      <Video src={src} muted={muted} style={{ position: "absolute", left, top, width: srcW * scale, height: srcH * scale, maxWidth: "none" }} />
    </div>
  );
}

function Hook({ text, top }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!text) return null;
  const inn = spring({ frame, fps, config: { damping: 14, stiffness: 180 }, durationInFrames: 10 });
  const out = interpolate(frame, [fps * 2.2, fps * 2.6], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (out <= 0) return null;
  return (
    <div style={{ position: "absolute", top, left: 0, width: W, display: "flex", justifyContent: "center", transform: `translateY(-50%) scale(${interpolate(inn, [0, 1], [0.7, 1])})`, opacity: out }}>
      <div style={{ maxWidth: 920, padding: "22px 36px", background: colors.text, color: "#000", borderRadius: 18, fontFamily: `${font}, Arial Black, Impact, sans-serif`, fontWeight: 900, fontSize: 64, lineHeight: 1.1, textAlign: "center", boxShadow: "0 10px 40px rgba(0,0,0,0.45)" }}>
        {text}
      </div>
    </div>
  );
}

const Pill = ({ children, style }) =>
  children ? (
    <div style={{ position: "absolute", padding: "10px 20px", borderRadius: 999, background: colors.pill, color: colors.text, fontFamily: `${font}, Arial Black, Impact, sans-serif`, fontWeight: 800, fontSize: 30, ...style }}>{children}</div>
  ) : null;

export function Clip({ src, srcW, srcH, layout, facecam, game, captions, hook, credit, disclosure, duration }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const file = staticFile(src);
  // A slow push-in on the gameplay keeps the frame alive.
  const zoom = interpolate(frame, [0, Math.max(1, duration * fps)], [1, 1.06]);

  if (layout === "stacked" && facecam) {
    // Facecam on top, at its own shape (within limits), gameplay below.
    const faceH = Math.round(Math.min(860, Math.max(560, (W * facecam.h) / facecam.w)));
    const gameH = H - faceH;
    return (
      <AbsoluteFill style={{ background: "#000" }}>
        <Crop src={file} srcW={srcW} srcH={srcH} rect={facecam} bandW={W} bandH={faceH} muted />
        <Crop src={file} srcW={srcW} srcH={srcH} rect={game} bandW={W} bandH={gameH} zoom={zoom} style={{ top: faceH }} />
        <div style={{ position: "absolute", top: faceH - 3, width: W, height: 6, background: "#000" }} />
        <Pill style={{ top: 40, left: 32 }}>{credit}</Pill>
        <Pill style={{ top: 40, right: W - SAFE.right }}>{disclosure}</Pill>
        <Captions lines={captions} top={Math.min(SAFE.bottom - 260, faceH + Math.round(gameH * 0.42))} />
        <Hook text={hook} top={faceH} />
      </AbsoluteFill>
    );
  }

  // No facecam: blurred fill behind a 4:5 crop of the gameplay.
  const fgH = 1350;
  const fgTop = Math.round((H - fgH) / 2) - 60;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Crop src={file} srcW={srcW} srcH={srcH} rect={game} bandW={W} bandH={H} muted style={{ filter: "blur(40px) brightness(0.45)", transform: "scale(1.1)" }} />
      <Crop src={file} srcW={srcW} srcH={srcH} rect={game} bandW={W} bandH={fgH} zoom={zoom} style={{ top: fgTop }} />
      <Pill style={{ top: fgTop + fgH + 24, left: 32 }}>{credit}</Pill>
      <Pill style={{ top: 40, right: W - SAFE.right }}>{disclosure}</Pill>
      <Captions lines={captions} top={fgTop + Math.round(fgH * 0.6)} />
      <Hook text={hook} top={fgTop - 10} />
    </AbsoluteFill>
  );
}
