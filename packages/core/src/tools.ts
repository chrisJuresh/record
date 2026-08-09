/**
 * The versions of the external tools a Run used.
 *
 * Frames captured by a different Chromium are different Frames, and both copies
 * can sit on one machine at once, so which one made a clip is part of the
 * conditions that clip was produced under rather than a detail of this build.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ffmpegExecutable } from "./encode.js";

const execute = promisify(execFile);

export type ToolVersions = {
  /** The Node this tool itself ran on. */
  readonly node: string;
  /** The chrome-headless-shell the Frames were captured with. */
  readonly chrome: string | null;
  /** The ffmpeg the Artifacts were encoded with. */
  readonly ffmpeg: string | null;
};

/** What made this Run, asked of the tools themselves rather than assumed. */
export async function toolVersions(chrome: string): Promise<ToolVersions> {
  const [chromeVersion, ffmpegVersion] = await Promise.all([
    version(chrome, ["--version"], /([\d.]+)\s*$/),
    version(ffmpegExecutable(), ["-version"], /^ffmpeg version (\S+)/),
  ]);

  return { node: process.version, chrome: chromeVersion, ffmpeg: ffmpegVersion };
}

/**
 * What one tool says it is. A version that will not be read is recorded as
 * missing rather than failing the Run: the same tool is about to capture or
 * encode, which is the proof that it runs.
 */
async function version(executable: string, args: string[], shape: RegExp): Promise<string | null> {
  const said = await execute(executable, args).then(
    ({ stdout }) => stdout,
    () => "",
  );

  return shape.exec(said.split(/\r?\n/)[0] ?? "")?.[1] ?? null;
}
