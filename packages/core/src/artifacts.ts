/**
 * The Artifacts a Run produces, and what is tunable about them.
 *
 * Three come out of the Frames of every Run (ADR 0006), because the delivery
 * targets genuinely differ: MP4 and WebM at the Project's video width and the
 * captured framerate, and a GIF smaller and slower. The GIF is the one Artifact
 * that can balloon and also the one most likely to be seen -- it is all a
 * README can play -- so its two size levers are Parameters with ranges rather
 * than constants.
 *
 * They describe encoding rather than motion, though, and an Action describes
 * motion. So no Action declares them: every Action carries them, and a new
 * Action is tunable the moment it exists.
 */
import { RecordError } from "./errors.js";
import { numberSetting, type Settled } from "./settings.js";

export type ArtifactFormat = "mp4" | "webm" | "gif";

/** How big something is drawn, in pixels. */
export type Dimensions = {
  readonly width: number;
  readonly height: number;
};

export type Artifact = {
  readonly format: ArtifactFormat;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly durationMs: number;
};

/**
 * The Parameters every Action carries. The defaults are what the GIF spike
 * measured as usable in a README: 640 wide at 20fps came to 3.88MB of the
 * photos grid, where the same clip at 800 and 24fps came to 8.51MB.
 */
export const artifactParameters = {
  gifWidth: {
    kind: "number",
    describes: "Width the GIF is encoded at, in pixels",
    default: 640,
    min: 120,
    max: 1920,
  },
  gifFramerate: {
    kind: "number",
    describes: "Frames per second the GIF plays at",
    default: 20,
    min: 5,
    max: 50,
  },
} as const;

/** How the GIF is encoded, once its Parameters have been resolved. */
export type GifSettings = {
  readonly width: number;
  readonly framerate: number;
};

/** The GIF's settings out of the Parameter values a Run resolved. */
export function gifSettings(values: Settled): GifSettings {
  return {
    width: numberSetting(values, "gifWidth"),
    framerate: numberSetting(values, "gifFramerate"),
  };
}

/**
 * The size an Artifact is encoded at: what was captured scaled to the requested
 * width, keeping its shape. H.264 needs both dimensions even, and no other
 * format minds them being so.
 *
 * What was captured is the Project's viewport, or the whole composited surround
 * where a Mockup was wrapped around it -- an Artifact is as wide as it was
 * asked to be either way, so a Mockup costs room inside the clip rather than
 * around it.
 */
export function artifactDimensions(captured: Dimensions, artifactWidth: number): Dimensions {
  const width = even(artifactWidth);
  return { width, height: even((width * captured.height) / captured.width) };
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}
