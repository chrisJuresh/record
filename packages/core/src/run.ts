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
 * Many Runs happen at once, because a Run's output depends on the stepped clock
 * rather than on wall-clock time (ADR 0001) -- however busy the machine gets,
 * the Frames are the ones the Timeline declared.
 *
 * A Matrix asks for several of them from one request, by varying the Condition
 * an Action records under rather than the Action. What a Condition comes to is
 * read in one place here -- the directory the Run is kept in, how wide the page
 * is, how it is put into a colour scheme, and what its Artifacts are called --
 * and handed onward as the ordinary arguments each of those already took.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { allParameters, effectiveParameters, loadAction } from "./action.js";
import { gifSettings, type Artifact } from "./artifacts.js";
import { findHeadlessShell } from "./browser.js";
import { captureFrames, type ColourScheme } from "./capture.js";
import { actionModule, readActions, readProject, readProjects, type ProjectConfig } from "./config.js";
import { cursorOverlay, cursorSettings } from "./cursor.js";
import { encodeArtifacts } from "./encode.js";
import { RecordError } from "./errors.js";
import { beginRun, pruneHistory, writeRun } from "./history.js";
import { ensureRunning, type RunningProject } from "./lifecycle.js";
import type { Condition } from "./matrix.js";
import { mockupAsked, mockupFor, noMockup, type Aperture } from "./mockup.js";
import { readOverrides } from "./overrides.js";
import { renderMockup, writeMockup, type Composite } from "./render.js";
import { headCommit, repositoryOf } from "./repository.js";
import type { ParameterSetting } from "./settings.js";
import { textSubstitution, type Substitution } from "./text.js";
import { themeSwitch } from "./theme.js";
import { toolVersions, type ToolVersions } from "./tools.js";
import { evaluateTimeline } from "./timeline.js";

/** How many Runs record at once when nobody says otherwise. */
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
  /**
   * The Condition a Matrix recorded this Run under, and nothing at all for a
   * Run asked for on its own. `switched` is how the colour scheme was put --
   * the Project's own hook where it declared one, and the emulated media query
   * otherwise. Whether the page then changed is reported by `mockup.colourScheme`
   * rather than insisted on: a site with one theme has one theme.
   */
  readonly condition: {
    readonly name: string;
    readonly scheme: ColourScheme | null;
    readonly width: number | null;
    readonly switched: "emulated" | "hook" | null;
  } | null;
  /** The Project's commit when it was recorded, which is what staleness compares. */
  readonly commit: string | null;
  /** The versions of the external tools that made it. */
  readonly tools: ToolVersions;
  readonly framerate: number;
  /**
   * What was drawn over the page, since no Frame contains a real pointer. An
   * Action that neither clicks nor types draws none unless it is asked to.
   */
  readonly cursor: {
    readonly shown: boolean;
    readonly style: string;
    readonly captions: boolean;
  };
  /**
   * The copy substituted into the page before the first Frame, and what each
   * selector matched -- so a clip showing wording the running site never had
   * says where that wording came from.
   */
  readonly text: readonly Substitution[];
  /**
   * The surround composited around the Frames. `asked` is what was chosen and
   * `name` is what that came to, which differ only where the page chose -- and
   * `name` is 'none' for the Run that composited nothing.
   */
  readonly mockup: {
    readonly asked: string;
    readonly name: string;
    /** How the page reads, which is what a Mockup left to choose itself went by. */
    readonly colourScheme: ColourScheme;
    /**
     * The surround as it was actually rendered, and where in it the Frames were
     * composited -- nothing at all for the Run that composited nothing.
     *
     * Reported because it is the one part of a Run that two correct-looking
     * numbers can disagree about: an Aperture that is not the size of the
     * Frames going into it is a clip scaled on the way in, which is how a
     * surround came to be laid over a quarter of its own canvas unnoticed.
     */
    readonly surround: {
      readonly width: number;
      readonly height: number;
      readonly aperture: Aperture;
    } | null;
  };
  /** What the Action actually ran with, declarations and Overrides together. */
  readonly parameters: Readonly<Record<string, ParameterSetting>>;
  /** Which of those came from an Override rather than the declaration. */
  readonly overridden: readonly string[];
  /** Overrides that could not be applied, reported rather than swallowed. */
  readonly warnings: readonly string[];
  readonly frames: {
    readonly captured: number;
    /** How big each Frame came out, which is what a Mockup was composited around. */
    readonly width: number;
    readonly height: number;
    /**
     * How many pixels of Frame each CSS pixel of page was captured as.
     *
     * **Measured**, as the width above against the CSS viewport, rather than
     * copied from the Project's `viewport.device_scale_factor` -- the Setting
     * says what was asked for, and this whole issue is what came of believing
     * that it was also what happened. Reported because it is what makes the
     * size above vary: a Frame twice the viewport is a page photographed at
     * scale 2, and one that is not is a clip that will be soft on a
     * high-density display however wide it was encoded.
     */
    readonly scale: number;
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

/**
 * How far through itself a Run is. Capture is much the longest of these and the
 * only one worth counting, which is why it is the one that carries a tally.
 */
export type RunStage = "starting" | "capturing" | "encoding" | "recorded" | "failed";

/**
 * What a Run is doing while it is still doing it, so that a ten-second render
 * does not look like a hang.
 *
 * Progress is watched, never stored: a Run's own record says what it produced,
 * and nothing it produces depends on whether anybody was listening. It names
 * the Run it is about because many Runs report at once.
 */
export type RunProgress = {
  readonly project: string;
  readonly action: string;
  /** The Condition it records under, and nothing where it varies none. */
  readonly condition: string | null;
  readonly stage: RunStage;
  /** Frames written and Frames the Timeline declared, while it is capturing them. */
  readonly frames?: { readonly captured: number; readonly of: number };
  /** What stopped it, on the stage that says one did. */
  readonly message?: string;
};

/** Told what a Run is up to as it happens, or nothing where nobody is watching. */
export type RunWatcher = (progress: RunProgress) => void;

export type RunOptions = {
  /** Told what the Run is doing while it is doing it. */
  readonly progress?: RunWatcher;
};

/** One Run that failed, named beside the others that recorded regardless. */
export type RunFailure = {
  readonly project: string;
  readonly action: string;
  /** The Condition it was being recorded under, and nothing where it was not. */
  readonly condition: string | null;
  /** What stopped it, as recording that Action on its own would have said. */
  readonly message: string;
};

/** What recording many Actions produced, and what it could not. */
export type RunSummary = {
  /** How many Runs were allowed to record at once. */
  readonly concurrency: number;
  /** The Conditions a Matrix varied, in order, and none for a plain request. */
  readonly conditions: readonly string[];
  /** What each Run that recorded produced, in the order they were asked for. */
  readonly runs: readonly RunReport[];
  /** The Runs that did not record, and what stopped each. */
  readonly failures: readonly RunFailure[];
};

export type RunManyOptions = {
  /** Only this Project's Actions; every Project's when it is not named. */
  readonly project?: string;
  /**
   * Only this Action of that Project. Named alongside Conditions, so that one
   * Action can be recorded across a Matrix without every other one being.
   */
  readonly action?: string;
  /**
   * The Conditions to record each Action under, which is the Matrix. None of
   * them records each Action exactly once, as a plain request always has.
   */
  readonly conditions?: readonly Condition[];
  /** How many Runs record at once, rather than `defaultConcurrency`. */
  readonly concurrency?: number;
  /**
   * Told what each Run is doing while it is doing it. Several of them report at
   * once, so every progress names the Run it belongs to.
   */
  readonly progress?: RunWatcher;
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
  options: RunOptions = {},
): Promise<RunReport> {
  const project = await readProject(workspace, projectName);
  const outcome = await recordOne(
    workspace,
    { project, action: actionName, lease: { outstanding: 1 } },
    options.progress,
  );

  // Asked for one Action, so its failure is the command's failure rather than
  // an entry in a summary of what else recorded.
  if (!("report" in outcome)) {
    throw outcome.failure;
  }

  return outcome.report;
}

/**
 * Runs every Action of one Project, or every Action of every Project, or one
 * named Action, each of them under every Condition a Matrix asked for -- several
 * at once.
 *
 * Recording concurrently is safe because a Run's output depends on the stepped
 * clock and not on wall-clock time (ADR 0001): contention for the machine
 * cannot perturb what the Frames are, only when they arrive. A Matrix's Runs
 * queue here with every other Run for exactly that reason -- a Condition varies
 * the circumstances the page is photographed under, not what a Frame is.
 *
 * One Run failing does not abandon the others. Each is recorded on its own
 * terms and the summary names the ones that failed, because a Project of twenty
 * Actions is not worth giving up over the one that cannot record.
 */
export async function runActions(
  workspace: string,
  options: RunManyOptions = {},
): Promise<RunSummary> {
  const concurrency = concurrencyOf(options.concurrency);
  const conditions = options.conditions ?? [];

  const configured =
    options.project === undefined
      ? await readProjects(workspace)
      : [await readProject(workspace, options.project)];

  const requested = await Promise.all(
    configured.map(async (project) => {
      const named = await declaredActions(workspace, project.name, options.action);

      // One lease per Project, shared by every Run recording against it, so
      // that the Project is started once rather than once a Run.
      const lease: Lease = { outstanding: named.length * Math.max(conditions.length, 1) };

      return named.flatMap((action) =>
        conditions.length === 0
          ? [{ project, action, lease }]
          : conditions.map((condition) => ({ project, action, lease, condition })),
      );
    }),
  );

  const runs: RunReport[] = [];
  const failures: RunFailure[] = [];

  for (const outcome of await recordEach(
    workspace,
    requested.flat(),
    concurrency,
    options.progress,
  )) {
    if ("report" in outcome) {
      runs.push(outcome.report);
    } else {
      failures.push({
        project: outcome.asked.project.name,
        action: outcome.asked.action,
        condition: outcome.asked.condition?.name ?? null,
        message: messageOf(outcome.failure),
      });
    }
  }

  return { concurrency, conditions: conditions.map((one) => one.name), runs, failures };
}

/**
 * The Actions this request names: every one the Project declares, or the single
 * one it asked for.
 *
 * A named Action is checked for here rather than left to fail as a Run, so that
 * a misspelling fails the command outright instead of arriving as one entry in
 * a summary for each Condition it would have recorded under.
 */
async function declaredActions(
  workspace: string,
  project: string,
  only: string | undefined,
): Promise<string[]> {
  if (only === undefined) {
    return readActions(workspace, project);
  }

  await actionModule(workspace, project, only);
  return [only];
}

/** One Run asked for, and the lease its Project is shared through. */
type AskedRun = {
  readonly project: ProjectConfig;
  readonly action: string;
  readonly lease: Lease;
  /** The Condition it records under, and nothing at all where it varies none. */
  readonly condition?: Condition;
};

/**
 * A Project held open for the Actions recording against it: started when the
 * first of them needs it, and stopped when the last of them is done.
 *
 * Starting one per Action would be a second server fighting the first for the
 * port, and stopping one per Action would stop it under the Actions still
 * recording against it.
 */
type Lease = {
  /** How many of the Project's Runs have still to let go of it. */
  outstanding: number;
  /** The Project answering, started once and shared, or nothing until one needs it. */
  running?: Promise<RunningProject>;
};

/** What one Run recorded, or what stopped it. */
type Outcome =
  | { readonly asked: AskedRun; readonly report: RunReport }
  | { readonly asked: AskedRun; readonly failure: unknown };

/**
 * Records each of them, at most `concurrency` at once, and answers in the order
 * they were asked for rather than the order they happened to finish.
 */
async function recordEach(
  workspace: string,
  requested: readonly AskedRun[],
  concurrency: number,
  watching: RunWatcher | undefined,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];

  // One queue drawn from by every worker, rather than a share of the Actions
  // handed to each: a slow Action then holds up nothing but itself.
  const queue = requested.entries();

  const worker = async () => {
    for (const [at, asked] of queue) {
      outcomes[at] = await recordOne(workspace, asked, watching);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, requested.length) }, worker));

  return outcomes;
}

/** Records one Action, answering with what stopped it rather than throwing it. */
async function recordOne(
  workspace: string,
  asked: AskedRun,
  watching: RunWatcher | undefined,
): Promise<Outcome> {
  try {
    return { asked, report: await record(workspace, asked, watching) };
  } catch (failure) {
    return { asked, failure };
  }
}

/** What a failure says for itself, which is what the summary names it by. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** How many Actions may record at once, or a failure naming what was asked for instead. */
function concurrencyOf(asked: number | undefined): number {
  const concurrency = asked ?? defaultConcurrency;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RecordError(`${concurrency} is not a number of Actions to record at once`);
  }

  return concurrency;
}

/** Everything one Run does, from the Action's declaration to its Artifacts. */
async function record(
  workspace: string,
  asked: AskedRun,
  watching: RunWatcher | undefined,
): Promise<RunReport> {
  const { project, action: actionName, lease, condition } = asked;
  const projectName = project.name;

  /** Says where this Run has got to, to whoever asked to be told. */
  const reached = (
    stage: RunStage,
    detail: Omit<RunProgress, "project" | "action" | "condition" | "stage"> = {},
  ): void => {
    watching?.({
      project: projectName,
      action: actionName,
      condition: condition?.name ?? null,
      stage,
      ...detail,
    });
  };

  reached("starting");

  // A Condition varies the circumstances rather than the Action, so everything
  // it touches is settled here: where the Run is kept, how wide the page is,
  // how it is put into a colour scheme, and what its Artifacts are called.
  const viewport =
    condition?.width === undefined
      ? project.viewport
      : { ...project.viewport, width: condition.width };
  const theme = themeSwitch(condition?.scheme, project.theme);
  // Named apart, because the Artifacts of light and dark are two clips: a
  // README naming one of them must not be able to be handed the other.
  const named = condition === undefined ? actionName : `${actionName}-${condition.name}`;

  /** This Run's own directory, once it has one to clean up after itself. */
  let produced: string | undefined;

  try {
    const action = await loadAction(await actionModule(workspace, projectName, actionName));

    const effective = effectiveParameters(
      allParameters(action, project),
      await readOverrides(workspace, projectName, actionName),
    );

    const timeline = action.timeline(effective.values);
    const states = evaluateTimeline(timeline);
    if (states.length === 0) {
      throw new RecordError(`'${actionName}' declares a Timeline that produces no Frames`);
    }

    // What is drawn over the page rather than what the page does, and settled
    // here beside the Timeline it is drawn from: an Action that cannot say what
    // to draw should cost no more than one that cannot describe a clip.
    const cursor = cursorSettings(effective.values, timeline);
    const overlay = cursorOverlay(cursor);

    // Copy rather than motion, and so decided here beside the cursor rather
    // than by the Timeline: what the page says is not something a Frame does.
    const substitution = textSubstitution(action.text ?? {});

    // Which surround was asked for. What that comes to may be the page's
    // answer, so it is only settled once there is a page to ask.
    const asked = mockupAsked(effective.values);

    // Before anything is written, and before a Project is asked for at all: an
    // Action that cannot describe a clip costs nothing to find out about, and
    // the retained Runs are still where they were.
    //
    // The Project is started by whichever of its Actions needs it first, and
    // every other Action recording against it waits on that same start.
    const running = await (lease.running ??= ensureRunning(project));

    const executable = await findHeadlessShell();

    const begun = await beginRun(workspace, projectName, actionName, new Date(), condition?.name);
    produced = begun.directory;
    const frames = join(begun.directory, "frames");

    // What the clip was made under, read while it is being made rather than
    // asked for afterwards, when the answer could already have changed.
    const [tools, commit] = await Promise.all([
      toolVersions(executable),
      headCommit(repositoryOf(workspace, project)),
    ]);

    reached("capturing", { frames: { captured: 0, of: states.length } });

    const captured = await captureFrames({
      url: project.baseUrl,
      executable,
      viewport,
      framerate: timeline.framerate,
      states,
      directory: frames,
      progress: (written) => {
        reached("capturing", { frames: { captured: written, of: states.length } });
      },
      ...(overlay === undefined ? {} : { overlay }),
      ...(substitution === undefined ? {} : { substitution }),
      ...(theme === undefined ? {} : { theme }),
    });

    // Rendered after the Frames rather than before them, because a Mockup left
    // to choose itself is chosen by the page the Frames are of. It lands beside
    // them, so it is swept up with them.
    const surround = await composite(asked, captured.colourScheme, {
      executable,
      viewport,
      file: join(frames, "mockup.png"),
    });

    reached("encoding");

    const encoded = await encodeArtifacts({
      frames,
      frameCount: states.length,
      framerate: timeline.framerate,
      viewport,
      videoWidth: project.videoWidth,
      gif: gifSettings(effective.values),
      ...(surround === undefined ? {} : { mockup: surround.composite }),
      directory: begun.directory,
      name: named,
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
      condition:
        condition === undefined
          ? null
          : {
              name: condition.name,
              scheme: condition.scheme ?? null,
              width: condition.width ?? null,
              switched: theme?.kind ?? null,
            },
      commit,
      tools,
      framerate: timeline.framerate,
      cursor: { shown: cursor.shown, style: cursor.style.name, captions: cursor.captions },
      text: captured.substituted,
      mockup: {
        asked,
        name: surround?.name ?? noMockup,
        colourScheme: captured.colourScheme,
        surround:
          surround === undefined
            ? null
            : {
                width: surround.composite.width,
                height: surround.composite.height,
                aperture: surround.composite.aperture,
              },
      },
      parameters: effective.values,
      overridden: effective.overridden,
      warnings: effective.warnings,
      frames: {
        captured: states.length,
        width: captured.size.width,
        height: captured.size.height,
        scale: captured.size.width / viewport.width,
        priming: captured.priming,
        repeated: captured.repeated,
        hashes: captured.hashes,
      },
      artifacts: encoded.artifacts,
      embed: encoded.embed,
      lifecycle: { readyUrl: running.readyUrl, started: running.started },
    };

    await writeRun(report);
    await pruneHistory(workspace, projectName, actionName, condition?.name);

    reached("recorded");

    return report;
  } catch (failure) {
    reached("failed", { message: messageOf(failure) });

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
 * The surround this Run composites its Frames into, rendered and written where
 * the encoder can read it -- or nothing at all where the Run composites
 * nothing, which encodes the Frames exactly as a Run without the feature would.
 *
 * Rendered by the same browser that captured the Frames, so a template is CSS
 * somebody can open rather than drawing instructions the encoder has to be
 * taught. Every preset goes through this, which is what makes adding one adding
 * a template.
 */
async function composite(
  asked: string,
  scheme: ColourScheme,
  into: { executable: string; viewport: ProjectConfig["viewport"]; file: string },
): Promise<{ name: string; composite: Composite } | undefined> {
  const mockup = mockupFor(asked, scheme);

  if (mockup === undefined) {
    return undefined;
  }

  const rendered = await renderMockup(mockup, {
    executable: into.executable,
    viewport: into.viewport,
  });

  return { name: rendered.name, composite: await writeMockup(rendered, into.file) };
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
