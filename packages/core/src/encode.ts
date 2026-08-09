/**
 * Encoding captured Frames into the Artifacts a Run produces, with ffmpeg.
 *
 * All three come out of the one pile of Frames (ADR 0006) and they arrive
 * together: each is encoded beside where it belongs and moved into place only
 * once every one of them has succeeded. A Run that fails halfway therefore
 * leaves the last good set exactly as it was, rather than a mixture of the two.
 */
import { spawn } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  artifactDimensions,
  type Artifact,
  type ArtifactFormat,
  type GifSettings,
} from "./artifacts.js";
import { framePattern } from "./capture.js";
import type { Viewport } from "./config.js";
import { embedSnippet } from "./embed.js";
import { RecordError } from "./errors.js";

export type EncodeOptions = {
  /** Directory the Frames were written into. */
  readonly frames: string;
  readonly frameCount: number;
  /** The framerate the Frames were captured at, which the video Artifacts keep. */
  readonly framerate: number;
  readonly viewport: Viewport;
  /** Width the video Artifacts are encoded at, from the Project's configuration. */
  readonly videoWidth: number;
  readonly gif: GifSettings;
  /** Directory the Artifacts are written into, and the name they take. */
  readonly directory: string;
  readonly name: string;
};

export type Encoded = {
  /** MP4, WebM and GIF, in that order. */
  readonly artifacts: readonly Artifact[];
  /** The embed snippet written beside them. */
  readonly embed: string;
};

/** What one Artifact is encoded at, whatever format it is. */
type Shape = {
  readonly format: ArtifactFormat;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly frameCount: number;
};

/** One Artifact as it will be, and the ffmpeg run that makes it. */
type Planned = {
  readonly artifact: Artifact;
  /** Where it is encoded before it is moved into place. */
  readonly partial: string;
  readonly args: readonly string[];
};

export async function encodeArtifacts(options: EncodeOptions): Promise<Encoded> {
  const planned = plan(options);

  // Every encode is waited for even once one has failed, so that cleaning up
  // cannot race an ffmpeg still writing the file it is trying to remove.
  const outcomes = await Promise.allSettled(planned.map((one) => ffmpeg(one.args)));
  const failed = outcomes.find((outcome) => outcome.status === "rejected");

  if (failed !== undefined) {
    await Promise.all(planned.map((one) => rm(one.partial, { force: true }).catch(() => undefined)));
    throw failed.reason;
  }

  for (const one of planned) {
    await rename(one.partial, one.artifact.path);
  }

  const embed = join(options.directory, `${options.name}.embed.html`);
  const video = artifactDimensions(options.viewport, options.videoWidth);
  await writeFile(embed, embedSnippet({ name: options.name, ...video }), "utf8");

  return { artifacts: planned.map((one) => one.artifact), embed };
}

/** What each Artifact will be, decided before any of them is encoded. */
function plan(options: EncodeOptions): Planned[] {
  const video = artifactDimensions(options.viewport, options.videoWidth);
  const gif = artifactDimensions(options.viewport, options.gif.width);

  const shapes: Shape[] = [
    { format: "mp4", ...video, framerate: options.framerate, frameCount: options.frameCount },
    { format: "webm", ...video, framerate: options.framerate, frameCount: options.frameCount },
    {
      format: "gif",
      ...gif,
      framerate: options.gif.framerate,
      // The GIF plays slower than the page was captured, so the fps filter
      // resamples the Frames: how many it emits follows from the two framerates
      // rather than from how many were captured.
      frameCount: Math.max(
        1,
        Math.round((options.frameCount / options.framerate) * options.gif.framerate),
      ),
    },
  ];

  return shapes.map((shape) => {
    const file = join(options.directory, `${options.name}.${shape.format}`);
    const partial = `${file}.partial.${shape.format}`;

    return {
      artifact: {
        format: shape.format,
        path: file,
        width: shape.width,
        height: shape.height,
        framerate: shape.framerate,
        durationMs: Math.round((shape.frameCount / shape.framerate) * 1000),
      },
      partial,
      args: argumentsFor(options, shape, partial),
    };
  });
}

/** The ffmpeg run that turns the captured Frames into one Artifact. */
function argumentsFor(options: EncodeOptions, shape: Shape, file: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-framerate",
    String(options.framerate),
    "-start_number",
    "0",
    "-i",
    join(options.frames, framePattern),
    "-frames:v",
    String(shape.frameCount),
    ...encoding(shape),
    file,
  ];
}

function encoding(shape: Shape): string[] {
  const scale = `scale=${shape.width}:${shape.height}:flags=lanczos`;

  switch (shape.format) {
    case "mp4":
      return [
        "-vf",
        scale,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        // The pixel format and the faststart atom are what make the file play
        // everywhere rather than only in the browser it was made on.
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-r",
        String(shape.framerate),
      ];
    case "webm":
      return [
        "-vf",
        scale,
        "-c:v",
        "libvpx-vp9",
        // A quality target rather than a bitrate: '-b:v 0' is what makes -crf
        // mean quality alone, and row threading is what makes VP9 bearable.
        "-crf",
        "32",
        "-b:v",
        "0",
        "-row-mt",
        "1",
        "-deadline",
        "good",
        "-cpu-used",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(shape.framerate),
      ];
    case "gif":
      return [
        // A palette generated from the clip itself: the resampled Frames are
        // split in two, one branch measures the colours the clip actually uses
        // and the other is mapped through them. 256 colours chosen from the
        // clip beat any fixed set of 256, by a margin that is plainly visible.
        "-filter_complex",
        `fps=${shape.framerate},${scale},split[measured][mapped];` +
          "[measured]palettegen[palette];[mapped][palette]paletteuse",
        // Loop forever: a clip that holds at both ends is meant to.
        "-loop",
        "0",
      ];
  }
}

async function ffmpeg(args: readonly string[]): Promise<void> {
  const executable = process.env["RECORD_FFMPEG"] || "ffmpeg";

  const said = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(executable, [...args]);
    let output = "";

    child.stderr.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    child.on("error", (failure) => {
      reject(
        new RecordError(
          `could not run ${executable}: ${failure.message}. Install ffmpeg, or name a copy in $RECORD_FFMPEG`,
        ),
      );
    });
    child.on("close", (code) => resolve({ code, output }));
  });

  if (said.code !== 0) {
    throw new RecordError(`ffmpeg failed encoding the Artifact:\n${lastLines(said.output)}`);
  }
}

/** ffmpeg says a great deal; the failure is at the end of it. */
function lastLines(output: string): string {
  return output.trimEnd().split(/\r?\n/).slice(-8).join("\n");
}
