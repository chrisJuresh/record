/**
 * A Run: one execution of an Action, together with what it produced.
 *
 * This is where configuration, Timeline evaluation, capture and encoding meet.
 * Everything a Run reports is something the operator can see for themselves --
 * the file it wrote, and the hashes of the Frames it wrote it from.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { allParameters, effectiveParameters, loadAction } from "./action.js";
import { gifSettings, type Artifact } from "./artifacts.js";
import { findHeadlessShell } from "./browser.js";
import { captureFrames } from "./capture.js";
import { actionModule, readProject } from "./config.js";
import { encodeArtifacts } from "./encode.js";
import { RecordError } from "./errors.js";
import { readOverrides } from "./overrides.js";
import { evaluateTimeline, type EasingName } from "./timeline.js";

export type RunReport = {
  readonly project: string;
  readonly action: string;
  readonly framerate: number;
  /** What the Action actually ran with, declarations and Overrides together. */
  readonly parameters: Readonly<Record<string, number | EasingName>>;
  /** Which of those came from an Override rather than the declaration. */
  readonly overridden: readonly string[];
  /** Overrides that could not be applied, reported rather than swallowed. */
  readonly warnings: readonly string[];
  readonly frames: {
    readonly captured: number;
    /** Frames driven before the first Frame was kept, which must not vary between Runs. */
    readonly priming: { readonly compositor: number; readonly settle: number };
    /** Frames the compositor reported undamaged, kept as repeats rather than dropped. */
    readonly repeated: number;
    /** One hash per captured Frame. The Frames themselves are gone by now. */
    readonly hashes: readonly string[];
  };
  /** MP4, WebM and GIF, in that order -- every Run produces all three (ADR 0006). */
  readonly artifacts: readonly Artifact[];
  /** Where the embed snippet naming both video Artifacts was written. */
  readonly embed: string;
};

/**
 * Runs one Action of one Project and returns what it produced.
 *
 * The Project is expected to already be answering; starting and stopping it is
 * a separate piece of work.
 */
export async function runAction(
  workspace: string,
  projectName: string,
  actionName: string,
): Promise<RunReport> {
  const project = await readProject(workspace, projectName);
  const action = await loadAction(await actionModule(workspace, projectName, actionName));

  const effective = effectiveParameters(
    allParameters(action),
    await readOverrides(workspace, projectName, actionName),
  );

  const timeline = action.timeline(effective.values);
  const states = evaluateTimeline(timeline);
  if (states.length === 0) {
    throw new RecordError(`'${actionName}' declares a Timeline that produces no Frames`);
  }

  const produced = join(workspace, "runs", projectName, actionName);
  const frames = join(produced, "frames");
  await rm(frames, { recursive: true, force: true });
  await mkdir(produced, { recursive: true });

  try {
    const captured = await captureFrames({
      url: project.baseUrl,
      executable: await findHeadlessShell(),
      viewport: project.viewport,
      framerate: timeline.framerate,
      states,
      directory: frames,
    });

    const encoded = await encodeArtifacts({
      frames,
      frameCount: states.length,
      framerate: timeline.framerate,
      viewport: project.viewport,
      videoWidth: project.videoWidth,
      gif: gifSettings(effective.values),
      directory: produced,
      name: actionName,
    });

    return {
      project: projectName,
      action: actionName,
      framerate: timeline.framerate,
      parameters: effective.values,
      overridden: effective.overridden,
      warnings: effective.warnings,
      frames: {
        captured: states.length,
        priming: captured.priming,
        repeated: captured.repeated,
        hashes: captured.hashes,
      },
      artifacts: encoded.artifacts,
      embed: encoded.embed,
    };
  } finally {
    // Frames are the bulk of a Run by far, and their only purpose was to be
    // encoded. Their hashes outlive them, and a Run that failed leaves no
    // half-recorded pile behind either. Failing to sweep up must not replace
    // whatever went wrong -- the next Run clears them before it starts.
    await rm(frames, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
}
