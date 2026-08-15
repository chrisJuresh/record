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
import type { Composite } from "./render.js";

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
  /** The Mockup composited around the Frames, where the Run composites one. */
  readonly mockup?: Composite;
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
  const video = artifactDimensions(options.mockup ?? options.viewport, options.videoWidth);
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
      ...artifactDimensions(options.mockup ?? options.viewport, options.gif.width),
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
    ...compositeInput(options.mockup),
    "-frames:v",
    String(encoding.frames),
    "-filter_complex",
    `${compositeChain(options.mockup, options.framerate)};${formatChain(encoding)}`,
    "-map",
    "[out]",
    ...formatArguments(encoding),
    ...bitExactArguments,
    file,
  ];
}

/**
 * The surround, if there is one: one image behind and around every Frame, read
 * as a second input rather than baked into the Frames themselves.
 */
function compositeInput(mockup: Composite | undefined): string[] {
  return mockup === undefined ? [] : ["-i", mockup.image];
}

/**
 * How a clip is put inside a Mockup, and the only way any of them is: the
 * backdrop the template left transparent, the clip fitted into the Aperture,
 * and the surround laid over the top so that whatever it draws across the clip
 * is drawn across the clip.
 *
 * This is the whole of what "adding a Mockup is adding a template" rests on --
 * every preset that ships is composited by these four filters, which is what
 * the contact sheet renders every one of them to show. A Run compositing
 * nothing passes its Frames straight through, so it encodes exactly what a Run
 * without the feature encoded.
 */
function compositeChain(mockup: Composite | undefined, framerate: number): string {
  if (mockup === undefined) {
    return "[0:v]null[shown]";
  }

  const { x, y, width, height } = mockup.aperture;

  return (
    `color=c=${ffmpegColour(mockup.backdrop)}:s=${mockup.width}x${mockup.height}:r=${framerate}[backdrop];` +
    // Fitted to fill the Aperture and cropped to the middle of what is left
    // over, because an Aperture the shape of the clip crops nothing and one
    // that is not -- a handset around a landscape clip -- must not squash it.
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height}[clip];` +
    `[backdrop][clip]overlay=${x}:${y}:shortest=1[inside];` +
    "[inside][1:v]overlay=0:0[shown]"
  );
}

/** What one Artifact's format does to the composited clip on the way out. */
function formatChain(encoding: Encoding): string {
  if (encoding.format !== "gif") {
    return `[shown]${scale(encoding)}[out]`;
  }

  // A palette generated from the clip itself: the resampled Frames are split in
  // two, one branch measures the colours the clip actually uses and the other
  // is mapped through them. 256 colours chosen from the clip beat any fixed set
  // of 256, by a margin that is plainly visible.
  return (
    `[shown]fps=${encoding.framerate},${scale(encoding)},split[measured][mapped];` +
    "[measured]palettegen[palette];[mapped][palette]paletteuse[out]"
  );
}

/**
 * What distinguishes one Artifact's format from the others'.
 *
 * The two video Artifacts are the same clip and are held to the same band of
 * quality (ADR 0006), but the number that asks for it is each encoder's own: 22
 * of x264 and 32 of VP9 are not the same scale and have nothing to say to each
 * other. What can be held against each other is what they produce, which is
 * what spikes/encode-quality measures.
 */
function formatArguments(encoding: Encoding): string[] {
  switch (encoding.format) {
    case "mp4":
      return [
        ...videoArguments(encoding),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        // The fallback for the browsers that cannot play the WebM (ADR 0006),
        // and nothing else -- so it is encoded to be watched rather than kept.
        // The 18 that used to stand here is an archival number, and archival is
        // what no Artifact here is: it spent twice the WebM's bytes to land
        // within a quarter of a VMAF point of it. 22 stays under a point of the
        // WebM at both the sizes measured, and is a third smaller than 18 was.
        "-crf",
        "22",
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
        // This is the Artifact offered first, so it is the last one worth
        // trading size on (spikes/run-cost) and 32 has not moved.
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
      // Loop forever: a clip that holds at both ends is meant to.
      return ["-loop", "0"];
  }
}

/**
 * What both video Artifacts do the same way, whatever encodes them: the pixel
 * format every player can decode, and the framerate the Frames were captured
 * at.
 */
function videoArguments(encoding: Encoding): string[] {
  return ["-pix_fmt", "yuv420p", "-r", String(encoding.framerate)];
}

function scale(encoding: Encoding): string {
  return `scale=${encoding.width}:${encoding.height}:flags=lanczos`;
}

/** A backdrop as ffmpeg reads a colour, or a failure naming the one that is not one. */
function ffmpegColour(css: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(css);

  if (hex === null) {
    throw new RecordError(`'${css}' is not a Mockup's backdrop, which is written #rrggbb`);
  }
  return `0x${hex[1] ?? ""}`;
}

export type CompositeFrameOptions = {
  /** One Frame, as an image file. */
  readonly frame: string;
  /** Its size, which is what an Artifact of it alone would keep the shape of. */
  readonly captured: Dimensions;
  /** The Mockup it goes inside, or nothing at all for the undecorated one. */
  readonly mockup?: Composite;
  /** How wide the image is written, as an Artifact of the same clip would be. */
  readonly width: number;
  readonly file: string;
};

/**
 * One Frame put inside one Mockup, written as an image.
 *
 * The same filters a Run composites its Frames through, so a contact sheet is
 * evidence about the pipeline rather than a second rendering that happens to
 * agree with it.
 */
export async function compositeFrame(options: CompositeFrameOptions): Promise<Dimensions> {
  const size = artifactDimensions(options.mockup ?? options.captured, options.width);

  await ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    options.frame,
    ...compositeInput(options.mockup),
    "-filter_complex",
    `${compositeChain(options.mockup, 1)};[shown]scale=${size.width}:${size.height}:flags=lanczos[out]`,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    ...bitExactArguments,
    options.file,
  ]);

  return size;
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
