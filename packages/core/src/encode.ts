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
  type Dimensions,
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
  /** Where the embed snippet was written. */
  readonly embed: string;
};

/** What one Artifact is encoded as, and how many Frames of it there are. */
type Encoding = {
  readonly format: ArtifactFormat;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly frames: number;
};

/** One Artifact as it will be, and the ffmpeg run that makes it. */
type Planned = {
  readonly artifact: Artifact;
  /** Where it is encoded before it is moved into place. */
  readonly partial: string;
  readonly args: readonly string[];
};

export async function encodeArtifacts(options: EncodeOptions): Promise<Encoded> {
  const video = artifactDimensions(options.viewport, options.videoWidth);
  const planned = plan(options, video);

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
  await writeFile(embed, embedSnippet({ name: options.name, ...video }), "utf8");

  return { artifacts: planned.map((one) => one.artifact), embed };
}

/** What each Artifact will be, decided before any of them is encoded. */
function plan(options: EncodeOptions, video: Dimensions): Planned[] {
  const asCaptured = { framerate: options.framerate, frames: options.frameCount };

  // Every Artifact is the same clip, so every one of them lasts as long as the
  // Timeline did. Only the GIF's Frames are resampled, and only its count of
  // them follows from a framerate of its own.
  const durationMs = Math.round((options.frameCount / options.framerate) * 1000);

  const encodings: Encoding[] = [
    { format: "mp4", ...video, ...asCaptured },
    { format: "webm", ...video, ...asCaptured },
    {
      format: "gif",
      ...artifactDimensions(options.viewport, options.gif.width),
      framerate: options.gif.framerate,
      // Rounded up, because this only ever caps what the fps filter emits: a
      // cap below what the clip holds would shorten the GIF rather than guard
      // it. ffmpeg stops at the last Frame either way.
      frames: Math.max(1, Math.ceil((options.frameCount / options.framerate) * options.gif.framerate)),
    },
  ];

  return encodings.map((encoding) => {
    const file = join(options.directory, `${options.name}.${encoding.format}`);
    const partial = `${file}.partial.${encoding.format}`;

    return {
      artifact: {
        format: encoding.format,
        path: file,
        width: encoding.width,
        height: encoding.height,
        framerate: encoding.framerate,
        durationMs,
      },
      partial,
      args: argumentsFor(options, encoding, partial),
    };
  });
}

/**
 * What makes an Artifact a function of the Frames it was encoded from and
 * nothing else. Without it Matroska stamps every WebM with the moment it was
 * written and an identifier of its own, so two Runs of an unchanged Action
 * would produce clips that differ in bytes while being the same clip -- which
 * is exactly the comparison this tool exists to make.
 *
 * Given to the output rather than the input, where it would configure the
 * reading of the Frames instead of the writing of the Artifact.
 */
const bitExactArguments = ["-fflags", "+bitexact", "-flags:v", "+bitexact"];

/** The ffmpeg run that turns the captured Frames into one Artifact. */
function argumentsFor(options: EncodeOptions, encoding: Encoding, file: string): string[] {
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
    String(encoding.frames),
    ...formatArguments(encoding),
    ...bitExactArguments,
    file,
  ];
}

/** What distinguishes one Artifact's format from the others'. */
function formatArguments(encoding: Encoding): string[] {
  switch (encoding.format) {
    case "mp4":
      return [
        ...videoArguments(encoding),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        // The faststart atom is half of what makes the file play everywhere
        // rather than only in the browser it was made on.
        "-movflags",
        "+faststart",
      ];
    case "webm":
      return [
        ...videoArguments(encoding),
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
      ];
    case "gif":
      return [
        // A palette generated from the clip itself: the resampled Frames are
        // split in two, one branch measures the colours the clip actually uses
        // and the other is mapped through them. 256 colours chosen from the
        // clip beat any fixed set of 256, by a margin that is plainly visible.
        "-filter_complex",
        `fps=${encoding.framerate},${scale(encoding)},split[measured][mapped];` +
          "[measured]palettegen[palette];[mapped][palette]paletteuse",
        // Loop forever: a clip that holds at both ends is meant to.
        "-loop",
        "0",
      ];
  }
}

/**
 * What both video Artifacts do the same way, whatever encodes them: the scale
 * down from the captured Frames, the pixel format every player can decode, and
 * the framerate the Frames were captured at.
 */
function videoArguments(encoding: Encoding): string[] {
  return ["-vf", scale(encoding), "-pix_fmt", "yuv420p", "-r", String(encoding.framerate)];
}

function scale(encoding: Encoding): string {
  return `scale=${encoding.width}:${encoding.height}:flags=lanczos`;
}

/** The ffmpeg this machine encodes with: `$RECORD_FFMPEG` names one, or the one on PATH. */
export function ffmpegExecutable(): string {
  return process.env["RECORD_FFMPEG"] || "ffmpeg";
}

async function ffmpeg(args: readonly string[]): Promise<void> {
  const executable = ffmpegExecutable();

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
