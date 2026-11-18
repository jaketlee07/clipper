import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { colors, font } from "./theme.js";

// Adapted from video-pipeline's remotion/Captions.jsx for short-form: a few words
// at a time, big, in capitals, the spoken word lit up and popping in.
const bare = (word) => {
  const unquoted = word.replace(/^["“‘'(]+/, "").replace(/["”’')]+$/, "");
  return /^(?:[A-Z]\.)+$/.test(unquoted) ? unquoted : unquoted.replace(/[.,;:…]+$/, "").replace(/^[—–-]+$/, "");
};

export function Captions({ lines, top }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const line = lines.find((l) => t >= l.start && t < l.end);
  if (!line) return null;
  const shown = line.words.filter((w) => bare(w.text));
  return (
    <AbsoluteFill style={{ top, height: 260, justifyContent: "center", alignItems: "center", padding: "0 70px" }}>
      <div style={{ fontFamily: `${font}, Arial Black, Impact, sans-serif`, fontWeight: 900, fontSize: 82, lineHeight: 1.1, textAlign: "center", textTransform: "uppercase", letterSpacing: 1 }}>
        {shown.map((w, i) => {
          const spoken = t >= w.start;
          const current = spoken && (i === shown.length - 1 || t < shown[i + 1].start);
          const pop = current ? spring({ frame: frame - Math.round(w.start * fps), fps, config: { damping: 12, stiffness: 220 }, durationInFrames: 8 }) : 1;
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                margin: "0 12px",
                color: current ? colors.highlight : colors.text,
                transform: `scale(${current ? interpolate(pop, [0, 1], [0.85, 1.08]) : 1})`,
                WebkitTextStroke: `10px ${colors.stroke}`,
                paintOrder: "stroke fill",
                textShadow: "0 6px 18px rgba(0,0,0,0.6)",
              }}
            >
              {bare(w.text)}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
