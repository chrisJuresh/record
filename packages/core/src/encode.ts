/**
 * Encoding captured Frames into an Artifact with ffmpeg. Only MP4 for now --
 * WebM and GIF join it once one format is proven end to end (ADR 0006).
 */
import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { framePattern } from "./capture.js";
import type { Viewport } from "./config.js";
import { RecordError } from "./errors.js";

export type Artifact = {
  readonly format: "mp4";
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly durationMs: number;
};

export type EncodeOptions = {
  /** Directory the Frames were written into. */
  readonly frames: string;
  readonly frameCount: number;
  readonly framerate: number;
  readonly width: number;
  readonly height: number;
  /** Where the Artifact is written. */
  readonly file: string;
};

/**
 * The size a video Artifact is encoded at: the Project's viewport scaled to the
 * requested width, keeping its shape. H.264 needs both dimensions even.
 */
export function videoDimensions(viewport: Viewport, videoWidth: number): { width: number; height: number } {
  const width = even(videoWidth);
  return { width, height: even((width * viewport.height) / viewport.width) };
}

export async function encodeMp4(options: EncodeOptions): Promise<Artifact> {
  // Encoded beside the Artifact and moved into place, so that a failed encode
  // cannot leave a half-written file where the last good one was.
  const partial = `${options.file}.partial.mp4`;

  try {
    await encode(partial, options);
  } catch (failure) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw failure;
  }

  await rename(partial, options.file);

  return {
    format: "mp4",
    path: options.file,
    width: options.width,
    height: options.height,
    framerate: options.framerate,
    durationMs: Math.round((options.frameCount / options.framerate) * 1000),
  };
}

async function encode(file: string, options: EncodeOptions): Promise<void> {
  await ffmpeg([
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
    String(options.frameCount),
    "-vf",
    `scale=${options.width}:${options.height}:flags=lanczos`,
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
    String(options.framerate),
    file,
  ]);
}

async function ffmpeg(args: string[]): Promise<void> {
  const executable = process.env["RECORD_FFMPEG"] || "ffmpeg";

  const said = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(executable, args);
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

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}
