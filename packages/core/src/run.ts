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
import { ensureRunning } from "./lifecycle.js";
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
  /** What the Run did with the Project itself. */
  readonly lifecycle: {
    /** Where the Project was health-checked before recording began. */
    readonly readyUrl: string;
    /** Whether the Run started the Project, rather than finding it answering. */
    readonly started: boolean;
    /** Whether the Run stopped it again, which it does only if it started it. */
    readonly stopped: boolean;
  };
};

/**
 * Runs one Action of one Project and returns what it produced.
 *
 * A Project already answering is recorded as it stands and left running; one
 * that is not is started for the Run and stopped again afterwards, whether the
 * Run succeeded or not.
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

  // Before anything is written: a Project that will not come up costs nothing
  // to find out about, and the last good Run's Artifacts are still the Latest.
  const running = await ensureRunning(project);

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

    // Stopped before the Run reports, so that what it reports is what happened
    // rather than what was about to.
    const stopped = await running.stop();

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
      lifecycle: { readyUrl: running.readyUrl, started: running.started, stopped },
    };
  } finally {
    // Frames are the bulk of a Run by far, and their only purpose was to be
    // encoded. Their hashes outlive them, and a Run that failed leaves no
    // half-recorded pile behind either. Failing to sweep up must not replace
    // whatever went wrong -- the next Run clears them before it starts.
    await rm(frames, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);

    // A Project this Run started is stopped however the Run ended. Stopping is
    // idempotent, so the Run that already stopped it does not stop it twice.
    await running.stop();
  }
}
