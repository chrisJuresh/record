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
 *
 * Many Actions record at once, because a Run's output depends on the stepped
 * clock rather than on wall-clock time (ADR 0001) -- however busy the machine
 * gets, the Frames are the ones the Timeline declared.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { allParameters, effectiveParameters, loadAction } from "./action.js";
import { gifSettings, type Artifact } from "./artifacts.js";
import { findHeadlessShell } from "./browser.js";
import { captureFrames } from "./capture.js";
import { actionModule, readActions, readProject, readProjects, type ProjectConfig } from "./config.js";
import { encodeArtifacts } from "./encode.js";
import { RecordError } from "./errors.js";
import { beginRun, pruneHistory, writeRun } from "./history.js";
import { ensureRunning, type RunningProject } from "./lifecycle.js";
import { readOverrides } from "./overrides.js";
import { headCommit, repositoryOf } from "./repository.js";
import { toolVersions, type ToolVersions } from "./tools.js";
import { evaluateTimeline, type EasingName } from "./timeline.js";

/** How many Actions record at once when nobody says otherwise. */
export const defaultConcurrency = 4;

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
     * Whether the Project was started to record this Run rather than found
     * answering, which is also whether it was stopped again: a Project this
     * tool did not start is a Project it leaves running. Actions recording at
     * once share one start, so this says the Project was started for them
     * rather than that this Action alone started it.
     */
    readonly started: boolean;
  };
};

/** One Action that failed, named beside the others that recorded regardless. */
export type RunFailure = {
  readonly project: string;
  readonly action: string;
  /** What stopped it, as recording that Action on its own would have said. */
  readonly message: string;
};

/** What recording many Actions produced, and what it could not. */
export type RunSummary = {
  /** How many Actions were allowed to record at once. */
  readonly concurrency: number;
  /** What each Action that recorded produced, in the order they were asked for. */
  readonly runs: readonly RunReport[];
  /** The Actions that did not record, and what stopped each. */
  readonly failures: readonly RunFailure[];
};

export type RunManyOptions = {
  /** Only this Project's Actions; every Project's when it is not named. */
  readonly project?: string;
  /** How many Actions record at once, rather than `defaultConcurrency`. */
  readonly concurrency?: number;
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
  const outcome = await recordOne(workspace, {
    project,
    action: actionName,
    lease: { outstanding: 1 },
  });

  // Asked for one Action, so its failure is the command's failure rather than
  // an entry in a summary of what else recorded.
  if (!("report" in outcome)) {
    throw outcome.failure;
  }

  return outcome.report;
}

/**
 * Runs every Action of one Project, or every Action of every Project, several
 * at once.
 *
 * Recording concurrently is safe because a Run's output depends on the stepped
 * clock and not on wall-clock time (ADR 0001): contention for the machine
 * cannot perturb what the Frames are, only when they arrive.
 *
 * One Action failing does not abandon the others. Each is recorded on its own
 * terms and the summary names the ones that failed, because a Project of twenty
 * Actions is not worth giving up over the one that cannot record.
 */
export async function runActions(
  workspace: string,
  options: RunManyOptions = {},
): Promise<RunSummary> {
  const configured =
    options.project === undefined
      ? await readProjects(workspace)
      : [await readProject(workspace, options.project)];

  const asked = await Promise.all(
    configured.map(async (project) => {
      const named = await readActions(workspace, project.name);
      // One lease per Project, shared by every Action recording against it, so
      // that the Project is started once rather than once an Action.
      const lease: Lease = { outstanding: named.length };

      return named.map((action) => ({ project, action, lease }));
    }),
  );

  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? defaultConcurrency));
  const outcomes = await recordEach(workspace, asked.flat(), concurrency);

  return {
    concurrency,
    runs: outcomes.flatMap((outcome) => ("report" in outcome ? [outcome.report] : [])),
    failures: outcomes.flatMap((outcome) =>
      "report" in outcome
        ? []
        : [
            {
              project: outcome.recording.project.name,
              action: outcome.recording.action,
              message: messageOf(outcome.failure),
            },
          ],
    ),
  };
}

/** One Action to record, and the lease its Project is shared through. */
type Recording = {
  readonly project: ProjectConfig;
  readonly action: string;
  readonly lease: Lease;
};

/**
 * A Project held open for the Actions recording against it: started when the
 * first of them needs it, and stopped when the last of them is done.
 */
type Lease = {
  /** How many of the Project's Actions have still to let go of it. */
  outstanding: number;
  /** The Project answering, started once and shared, or nothing until one needs it. */
  running?: Promise<RunningProject>;
};

/** What one Action recorded, or what stopped it. */
type Outcome =
  | { readonly recording: Recording; readonly report: RunReport }
  | { readonly recording: Recording; readonly failure: unknown };

/**
 * Records each of them, at most `concurrency` at once, and answers in the order
 * they were asked for rather than the order they happened to finish.
 */
async function recordEach(
  workspace: string,
  recordings: readonly Recording[],
  concurrency: number,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];

  // One queue drawn from by every worker, rather than a share of the Actions
  // handed to each: a slow Action then holds up nothing but itself.
  const queue = recordings.entries();

  const worker = async () => {
    for (const [at, recording] of queue) {
      outcomes[at] = await recordOne(workspace, recording);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, recordings.length) }, worker));

  return outcomes;
}

/** Records one Action, answering with what stopped it rather than throwing it. */
async function recordOne(workspace: string, recording: Recording): Promise<Outcome> {
  try {
    return { recording, report: await record(workspace, recording) };
  } catch (failure) {
    return { recording, failure };
  }
}

/** What a failure says for itself, which is what the summary names it by. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** Everything one Run does, from the Action's declaration to its Artifacts. */
async function record(workspace: string, recording: Recording): Promise<RunReport> {
  const { project, action: actionName, lease } = recording;
  const projectName = project.name;

  /** This Run's own directory, once it has one to clean up after itself. */
  let produced: string | undefined;

  try {
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

    // Before anything is written, and before a Project is asked for at all: an
    // Action that cannot describe a clip costs nothing to find out about, and
    // the retained Runs are still where they were.
    const running = await acquire(lease, project);

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
    await pruneHistory(workspace, projectName, actionName);

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
    // Let go of the Project however this Run ended, including before it was
    // ever asked for -- a lease nobody let go of is a Project left running.
    await release(lease);
  }
}

/**
 * The Project answering, started at most once however many of its Actions
 * record against it. Starting one per Action would be a second server fighting
 * the first for the port, and would stop the Project under the Actions still
 * recording against it.
 */
async function acquire(lease: Lease, project: ProjectConfig): Promise<RunningProject> {
  lease.running ??= ensureRunning(project);

  return lease.running;
}

/**
 * Lets go of the Project one Action is done with, and stops it once the last of
 * them has -- and only if this tool started it. A Project that never came up
 * stopped itself on the way, so there is nothing left here to stop.
 */
async function release(lease: Lease): Promise<void> {
  lease.outstanding--;

  if (lease.outstanding > 0 || lease.running === undefined) {
    return;
  }

  const running = await lease.running.catch(() => undefined);
  await running?.stop();
}
