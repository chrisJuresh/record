/**
 * A Run: one execution of an Action, together with what it produced.
 *
 * This is where configuration, Timeline evaluation, capture and encoding meet.
 * Everything a Run reports is something the operator can see for themselves --
 * the file it wrote, and the hashes of the Frames it wrote it from.
 */
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { effectiveParameters, loadAction } from "./action.js";
import { findHeadlessShell } from "./browser.js";
import { captureFrames } from "./capture.js";
import { readProject } from "./config.js";
import { encodeMp4, videoDimensions, type Artifact } from "./encode.js";
import { RecordError } from "./errors.js";
import { evaluateTimeline } from "./timeline.js";

export type RunReport = {
  readonly project: string;
  readonly action: string;
  readonly framerate: number;
  readonly frames: {
    readonly captured: number;
    /** Frames driven before the first Frame was kept, which must not vary between Runs. */
    readonly priming: { readonly compositor: number; readonly settle: number };
    /** Frames the compositor reported undamaged, kept as repeats rather than dropped. */
    readonly repeated: number;
    /** One hash per captured Frame. The Frames themselves are gone by now. */
    readonly hashes: readonly string[];
  };
  readonly artifacts: readonly Artifact[];
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
  const action = await loadAction(await actionFile(workspace, projectName, actionName));

  const timeline = action.timeline(effectiveParameters(action.parameters));
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

    const artifact = await encodeMp4({
      frames,
      frameCount: states.length,
      framerate: timeline.framerate,
      ...videoDimensions(project.viewport, project.videoWidth),
      file: join(produced, `${actionName}.mp4`),
    });

    return {
      project: projectName,
      action: actionName,
      framerate: timeline.framerate,
      frames: {
        captured: states.length,
        priming: captured.priming,
        repeated: captured.repeated,
        hashes: captured.hashes,
      },
      artifacts: [artifact],
    };
  } finally {
    // Frames are the bulk of a Run by far, and their only purpose was to be
    // encoded. Their hashes outlive them, and a Run that failed leaves no
    // half-recorded pile behind either. Failing to sweep up must not replace
    // whatever went wrong -- the next Run clears them before it starts.
    await rm(frames, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
}

async function actionFile(workspace: string, project: string, action: string): Promise<string> {
  const file = join(workspace, "projects", project, "actions", `${action}.ts`);

  return access(file).then(
    () => file,
    () => {
      throw new RecordError(`no Action named '${action}' is declared by Project '${project}'`);
    },
  );
}
