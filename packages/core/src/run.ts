/**
 * A Run: one execution of an Action, together with what it produced.
 *
 * This is where configuration, Timeline evaluation, capture and encoding meet.
 * Everything a Run reports is something the operator can see for themselves --
 * the file it wrote, and the hashes of the Frames it wrote it from.
 *
 * A Run is not disposable: it keeps what it produced in a directory of its own,
 * beside a record of the conditions it was produced under, until ten newer Runs
 * of the same Action have replaced it.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { allParameters, effectiveParameters, loadAction } from "./action.js";
import { gifSettings, type Artifact } from "./artifacts.js";
import { findHeadlessShell } from "./browser.js";
import { captureFrames } from "./capture.js";
import { actionModule, readProject } from "./config.js";
import { encodeArtifacts } from "./encode.js";
import { RecordError } from "./errors.js";
import { beginRun, historyDirectory, pruneHistory, writeRun } from "./history.js";
import { ensureRunning } from "./lifecycle.js";
import { readOverrides } from "./overrides.js";
import { headCommit, repositoryOf } from "./repository.js";
import { toolVersions, type ToolVersions } from "./tools.js";
import { evaluateTimeline, type EasingName } from "./timeline.js";

export type RunReport = {
  readonly project: string;
  readonly action: string;
  /** What this Run is called, which is also the instant it began. */
  readonly id: string;
  /** When it began, as an ISO instant. */
  readonly recordedAt: string;
  /** Where its Artifacts, its snippet and this record are kept. */
  readonly directory: string;
  /** The Project's commit when it was recorded, which is what staleness compares. */
  readonly commit: string | null;
  /** The versions of the external tools that made it. */
  readonly tools: ToolVersions;
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
    /**
     * Whether the Run started the Project rather than finding it answering,
     * which is also whether it stopped it: a Project it did not start is a
     * Project it leaves running.
     */
    readonly started: boolean;
  };
};

/**
 * Runs one Action of one Project and returns what it produced.
 *
 * A Project already answering is recorded as it stands and left running; one
 * that is not is started for the Run and stopped again afterwards, whether the
 * Run succeeded or not.
 *
 * What it produces goes into a directory of this Run's own, so a Run that fails
 * takes only its own away with it and every earlier Run is left where it was.
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
  // to find out about, and the retained Runs are still where they were.
  const running = await ensureRunning(project);

  /** This Run's own directory, once it has one to clean up after itself. */
  let produced: string | undefined;

  // Everything from here is inside the try, so that nothing between starting a
  // Project and stopping it again can leave one running.
  try {
    const executable = await findHeadlessShell();

    const begun = await beginRun(workspace, projectName, actionName, new Date());
    produced = begun.directory;
    const frames = join(begun.directory, "frames");

    // What the clip was made under, read while it is being made rather than
    // asked for afterwards, when the answer could already have changed.
    const [tools, commit] = await Promise.all([
      toolVersions(executable),
      headCommit(repositoryOf(workspace, project)),
    ]);

    const captured = await captureFrames({
      url: project.baseUrl,
      executable,
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
      directory: begun.directory,
      name: actionName,
    });

    // Frames are the bulk of a Run by far, and their only purpose was to be
    // encoded; their hashes outlive them. Failing to sweep up must not replace
    // a Run that succeeded -- what is left of them goes when the Run is pruned.
    await rm(frames, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);

    const report: RunReport = {
      project: projectName,
      action: actionName,
      id: begun.id,
      recordedAt: begun.recordedAt,
      directory: begun.directory,
      commit,
      tools,
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
      lifecycle: { readyUrl: running.readyUrl, started: running.started },
    };

    await writeRun(report);
    await pruneHistory(historyDirectory(workspace, projectName, actionName));

    return report;
  } catch (failure) {
    // A Run that failed leaves nothing behind: its directory holds only its own
    // half of a recording, so taking it away is what leaves every earlier Run,
    // the Latest included, exactly as it was.
    if (produced !== undefined) {
      await rm(produced, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
    throw failure;
  } finally {
    // A Project this Run started is stopped however the Run ended, and one it
    // found already answering is left exactly as it was found.
    await running.stop();
  }
}
