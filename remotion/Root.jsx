import { Composition } from "remotion";
import { Clip } from "./Clip.jsx";

// Props come from src/render.mjs: one clip's cut, layout, captions and overlays.
export const Root = () => (
  <Composition
    id="Clip"
    component={Clip}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={30}
    defaultProps={{ fps: 30, duration: 1, src: "clip.mp4", srcW: 1920, srcH: 1080, layout: "full", facecam: null, game: { x: 0, y: 0, w: 1920, h: 1080 }, captions: [], hook: "", credit: "", disclosure: "" }}
    calculateMetadata={({ props }) => ({ fps: props.fps, durationInFrames: Math.max(1, Math.ceil(props.duration * props.fps)) })}
  />
);
