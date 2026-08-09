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
import type { Viewport } from "./config.js";
import { RecordError } from "./errors.js";
import type { EasingName } from "./timeline.js";

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
export function gifSettings(values: Readonly<Record<string, number | EasingName>>): GifSettings {
  return { width: numberFrom(values, "gifWidth"), framerate: numberFrom(values, "gifFramerate") };
}

/**
 * The size an Artifact is encoded at: the Project's viewport scaled to the
 * requested width, keeping its shape. H.264 needs both dimensions even, and no
 * other format minds them being so.
 */
export function artifactDimensions(viewport: Viewport, artifactWidth: number): Dimensions {
  const width = even(artifactWidth);
  return { width, height: even((width * viewport.height) / viewport.width) };
}

/**
 * Every Artifact Parameter is declared a number, so a value that is not one
 * means the declarations and this reader have drifted apart rather than that
 * somebody typed something wrong.
 */
function numberFrom(values: Readonly<Record<string, number | EasingName>>, name: string): number {
  const value = values[name];

  if (typeof value !== "number") {
    throw new RecordError(`Parameter '${name}' resolved to '${String(value)}' rather than to a number`);
  }
  return value;
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}
