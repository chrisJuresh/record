/**
 * What the app knows, and what each answer from the server does to it.
 *
 * Nothing here touches the document: the state is what the page is drawn from,
 * so that "what a Run in flight leaves the app looking like" is one readable
 * thing rather than a series of edits scattered through the rendering.
 *
 * The state is only ever what the server said. Nothing is inferred from what was
 * asked for -- a Run that recorded is the report the command gave for it, which
 * is also the new Latest, so nothing is fetched again to find out.
 */
import type {
  Ask,
  Failure,
  ParameterReport,
  Progress,
  Project,
  ProjectReport,
  PublishReport,
  Request,
  Run,
  StatusReport,
  Summary,
  TimelineReport,
} from "./api.js";

/** What an Action is doing, or nothing at all where it is not recording. */
export type Doing = {
  /** Asked for and waiting for the machine, before the Run has said anything. */
  readonly stage: "queued" | "starting" | "capturing" | "encoding";
  /** Frames written and Frames the Timeline declared, while it is capturing them. */
  readonly frames: { readonly captured: number; readonly of: number } | null;
};

export type ActionState = {
  readonly project: string;
  readonly action: string;
  /**
   * Every Run of it still kept on this machine, newest first. The first is the
   * Latest and the second is what the Latest is judged against, which is what
   * makes re-recording worth pressing -- so the history is held rather than the
   * newest of it plucked out of the answer and the rest dropped.
   */
  history: readonly Run[];
  /**
   * Whether the Project has been committed to since it last ran, as
   * `record status` reports it -- and false where that command has not answered
   * yet, since an Action is flagged on what was read and never on a guess.
   */
  stale: boolean;
  doing: Doing | null;
  /** Why the last request naming it failed, in the command's own words. */
  failure: string | null;
  /**
   * What it declares and what it is tuned to, once it has been read -- which is
   * when it is put on the stage, because reading it imports the Action's module.
   */
  tuning: ParameterReport | null;
  /** Why the last change to its tuning was refused, in the command's own words. */
  refused: string | null;
};

export type ProjectState = {
  /**
   * The Project as the command reports it configured. Replaced whenever its
   * configuration is changed, since what the command answers with is the
   * Project as it now reads.
   */
  configured: Project;
  /**
   * What its repository is at now, as `record status` reports it -- and nothing
   * where there is no commit to read, or where it has not been read yet.
   */
  commit: string | null;
  /**
   * Everything it is configured with, once that has been read -- which is when
   * its configuration is put on the stage rather than when the app opens.
   */
  configuration: ProjectReport | null;
  /** Why the last change to its configuration was refused, in the command's own words. */
  misconfigured: string | null;
  readonly actions: readonly ActionState[];
};

/** The Action on the stage, which is the one whose Latest is playing. */
export type Chosen = { readonly project: string; readonly action: string };

/**
 * What the stage is showing: the Action's clips, what one Project is configured
 * with, a Project being configured for the first time, or what publishing would
 * make public.
 *
 * Configuration takes the stage rather than a column of its own, because it is
 * read and changed a few times in a Project's life and the clips are what the
 * app is open for the rest of the time. So does a publish, for a stronger
 * reason: what is about to go public is read before it is confirmed, and it is
 * a page of files and sizes rather than a line in a corner.
 */
export type Stage =
  | { readonly kind: "action" }
  | { readonly kind: "configuration"; readonly project: string }
  | { readonly kind: "new" }
  | { readonly kind: "publish" };

/**
 * The Preview on the stage: one Action played live against the running Project,
 * with no capture and no encoding anywhere in the loop.
 *
 * It is not a Run and never becomes one. It produces no Frames and no
 * Artifacts, keeps no history, is never the Latest, clears no staleness and
 * cannot be Published -- so nothing here is written into an Action's history
 * and nothing about it survives the Preview being turned off.
 */
export type Preview = {
  readonly project: string;
  readonly action: string;
  /** Where the Project is proxied, once the server has allocated an origin. */
  origin: string | null;
  /** The Timeline it replays, as the command evaluated it. */
  timeline: TimelineReport | null;
  /** Why there is no Preview, in the command's own words. */
  trouble: string | null;
};

/**
 * The Conditions every record button asks for beyond the Action itself, which
 * is a Matrix -- one Run per colour scheme, per viewport width, and one of each
 * where both are asked for.
 *
 * Ticked by hand for the request being made rather than declared per Project
 * and remembered. A Project that always records both themes would be a Setting,
 * and it would drag staleness in behind it: an Action with no unconditioned Run
 * is deliberately reported as never run, so declared Conditions would leave
 * every Action of that Project reading as never recorded until staleness
 * learned to count them. That is a bigger decision than wanting both themes,
 * and worth making after living with the boxes.
 */
export type Matrix = {
  /** The colour schemes ticked, and none to record the page as it paints. */
  readonly schemes: readonly string[];
  /**
   * The viewport widths, exactly as they were typed. Kept as the line rather
   * than as a list, because what a list of widths is -- and what a width is at
   * all -- is the command's answer, and it takes this same line.
   */
  readonly widths: string;
};

/**
 * The colour schemes a Matrix records across, which is the one piece of the
 * command's vocabulary the app spells for itself: a box has to be drawn per
 * scheme, and no command answers what there are.
 *
 * It is deliberately the only one, and the only one there is room for -- what a
 * scheme *does* still lives in the tool, which refuses anything else in its own
 * words. A `record schemes` to read them from would remove even this, and is
 * worth wanting the moment a third one exists.
 */
export const colourSchemes = ["light", "dark"] as const;

export type App = {
  projects: readonly ProjectState[];
  chosen: Chosen | null;
  /** What every record button records across, which is nothing until it is ticked. */
  matrix: Matrix;
  /** The Preview on the stage in place of the clips, or nothing where none is. */
  preview: Preview | null;
  /** What is on the stage, which is a clip unless a Project is being configured. */
  stage: Stage;
  /**
   * Why the Project the app was last asked to add was not configured, in the
   * command's own words. Kept apart from a configured Project's own refusals:
   * there is no Project for it to belong to yet.
   */
  notConfigured: string | null;
  /** Whether the rail shows a clip of each Action under its name. */
  railClips: boolean;
  /**
   * What publishing would make public, once the command has said -- and what
   * became of it once it was confirmed, which is the same report either way.
   *
   * Read again every time it is asked for rather than kept: what is about to go
   * public has to be what this machine holds now, and a plan drawn from an older
   * answer is a plan somebody would be confirming blind.
   */
  publish: PublishReport | null;
  /** Whether the command is answering about publishing right now. */
  publishing: boolean;
  /** Why publishing could not be read or carried out, in the command's own words. */
  notPublished: string | null;
  /** The requests being watched, and what each of them named. */
  readonly asked: Map<string, Ask>;
  /**
   * Staleness the command could not tell, in its own words. Said rather than
   * kept quiet: an Action that cannot be told Stale is not an Action that is
   * current, and only one of those means the clip on the stage still stands.
   */
  cannotTell: readonly string[];
  /**
   * Why staleness could not be read at all, in the words the attempt failed
   * with. Kept apart from `trouble` because it is drawn where staleness is,
   * rather than costing the page a paint while two clips are playing on it -- and
   * apart from `cannotTell`, which is the command answering that it cannot say.
   */
  unread: string | null;
  /** What the app itself could not do, which is never a Run failing. */
  trouble: string | null;
};

/** An app that has been told nothing yet. */
export function nothingYet(railClips: boolean): App {
  return {
    projects: [],
    chosen: null,
    matrix: { schemes: [], widths: "" },
    preview: null,
    stage: { kind: "action" },
    notConfigured: null,
    railClips,
    publish: null,
    publishing: false,
    notPublished: null,
    asked: new Map(),
    cannotTell: [],
    unread: null,
    trouble: null,
  };
}

/** The Project whose configuration is on the stage, or nothing where none is. */
export function configuring(app: App): ProjectState | undefined {
  return app.stage.kind === "configuration" ? projectOf(app, app.stage.project) : undefined;
}

/** One Project by name, or nothing where this machine has none by it. */
export function projectOf(app: App, project: string): ProjectState | undefined {
  return app.projects.find((state) => state.configured.name === project);
}

/**
 * What a Project is configured with, as the command has just reported it.
 *
 * Every answer about configuration is a whole report -- reading it, changing a
 * setting, adding a Project -- so this is the one way it ever changes, and the
 * Project the rail lists is replaced along with it: a Project just Published is
 * a Project the rail says is Published.
 */
export function configuredWith(app: App, report: ProjectReport): void {
  const project = projectOf(app, report.project);

  if (project !== undefined) {
    project.configuration = report;
    project.configured = report.configured;
    project.misconfigured = null;
  }
}

/**
 * Why a change to a Project's configuration was refused. What it is configured
 * with is left exactly as it was, because a setting the tool refused was never
 * written down.
 */
export function misconfigured(app: App, project: string, message: string): void {
  const state = projectOf(app, project);

  if (state !== undefined) {
    state.misconfigured = message;
  }
}

/**
 * An Action's most recent Run, whose Artifacts are the Latest -- and nothing at
 * all where it keeps none.
 */
export function latestOf(action: ActionState): Run | null {
  return action.history[0] ?? null;
}

/**
 * The Run before the Latest, which is what a change is judged against -- and
 * nothing for an Action that has only ever run once, which is an absence to say
 * rather than a player to leave empty.
 */
export function previousOf(action: ActionState): Run | null {
  return action.history[1] ?? null;
}

/** One Action of one Project, or nothing where neither is configured here. */
export function actionOf(app: App, project: string, action: string): ActionState | undefined {
  return actionsIn(app).find((state) => state.project === project && state.action === action);
}

/** The Action on the stage, or nothing where there is none to be on it. */
export function chosenAction(app: App): ActionState | undefined {
  return app.chosen === null ? undefined : actionOf(app, app.chosen.project, app.chosen.action);
}

/**
 * The Action the stage is playing, which is none at all while a Project is
 * being configured -- the clips and the configuration are not both on it.
 */
export function playing(app: App): ActionState | undefined {
  return app.stage.kind === "action" ? chosenAction(app) : undefined;
}

/**
 * The Preview on the stage, which is one of the Action being looked at or none
 * at all: a stage holding two clips and a live site at once is a stage nobody
 * can read.
 */
export function previewing(app: App): Preview | undefined {
  const action = playing(app);
  const preview = app.preview;

  return action !== undefined &&
    preview !== null &&
    preview.project === action.project &&
    preview.action === action.action
    ? preview
    : undefined;
}

/** The Project the Action on the stage belongs to. */
export function chosenProject(app: App): ProjectState | undefined {
  return app.chosen === null ? undefined : projectOf(app, app.chosen.project);
}

/** Every Action of every Project, in the order the rail lists them. */
export function actionsIn(app: App): readonly ActionState[] {
  return app.projects.flatMap((project) => project.actions);
}

/**
 * The Actions one request names: one of them, every one of a Project, or all of
 * them -- read from the request rather than from what happened, so that a
 * request that failed before any Run reported still knows whose failure it was.
 */
export function askedOf(app: App, ask: Ask): readonly ActionState[] {
  return app.projects
    .filter((project) => ask.project === undefined || project.configured.name === ask.project)
    .flatMap((project) =>
      project.actions.filter((action) => ask.action === undefined || action.action === ask.action),
    );
}

/** How many Actions are recording, which is what the topbar counts. */
export function recording(app: App): number {
  return actionsIn(app).filter((action) => action.doing !== null).length;
}

/**
 * The Conditions a request carries, and nothing at all where none is ticked --
 * which is the plain Run the app has always asked for, in the Action's own
 * directory under the Action's own name.
 *
 * The widths go as they were typed rather than as a list picked apart here: the
 * command takes exactly this line, so passing it on is the app relaying what
 * was asked for instead of holding a second opinion about what a width is.
 */
export function conditionsAsked(app: App): Pick<Ask, "schemes" | "widths"> {
  const widths = app.matrix.widths.trim();

  return {
    ...(app.matrix.schemes.length === 0 ? {} : { schemes: app.matrix.schemes }),
    ...(widths === "" ? {} : { widths: [widths] }),
  };
}

/**
 * Whether a press would be a Matrix, which is what says the clips on the stage
 * are not what is about to be recorded.
 *
 * Whether, and never how many: how a Matrix multiplies is the command's rule,
 * and counting the Runs here would mean splitting the widths on the way -- a
 * second reading of the same line, to print a number that a Condition the
 * command refuses makes untrue anyway.
 */
export function varied(app: App): boolean {
  return Object.keys(conditionsAsked(app)).length > 0;
}

/**
 * Ticks or unticks one colour scheme, leaving the others as they are and
 * keeping them in the order they are drawn in -- which is the order the
 * Conditions record in.
 */
export function varyScheme(app: App, scheme: string, on: boolean): void {
  app.matrix = {
    ...app.matrix,
    schemes: colourSchemes.filter((one) =>
      one === scheme ? on : app.matrix.schemes.includes(one),
    ),
  };
}

/** ...and the widths, exactly as they were typed. */
export function varyWidths(app: App, typed: string): void {
  app.matrix = { ...app.matrix, widths: typed };
}

/**
 * Marks what a request named as queued. The failure that request is being asked
 * for the second time about goes with it: a message about the Run before this
 * one, sitting under a Run in flight, reads as this one having failed already.
 */
export function asking(app: App, ask: Ask): void {
  for (const action of askedOf(app, ask)) {
    action.doing = { stage: "queued", frames: null };
    action.failure = null;
  }
}

/**
 * How every Action stands against its Project, as `record status` has just
 * reported it. Nothing else ever flags one Stale.
 *
 * Asked again as each request ends rather than cleared here: a Run recorded
 * against the Project as it stands now is not Stale, and reading that from the
 * command leaves what counts as Stale in the one place that decides it.
 */
export function stood(app: App, report: StatusReport): void {
  for (const project of app.projects) {
    const standing = report.projects.find((one) => one.project === project.configured.name);

    project.commit = standing?.commit ?? null;

    for (const action of project.actions) {
      // A Project the report says nothing about is one the command could not
      // read, which is not a reason to flag its Actions either way.
      action.stale = standing?.actions.find((one) => one.action === action.action)?.stale ?? false;
    }
  }

  app.cannotTell = report.warnings;
  app.unread = null;
}

/**
 * Why staleness could not be read, which leaves every flag exactly as it was.
 * Nothing is cleared: an answer that never arrived says nothing about whether an
 * Action is Stale, and clearing the flags would say it was not.
 */
export function unread(app: App, message: string): void {
  app.unread = message;
}

/**
 * What an Action declares and is tuned to, as the command has just reported it.
 *
 * Every answer about tuning is a whole report -- reading it, setting an Override,
 * removing one -- so this is the one way it ever changes, and the app never has
 * to work out what a change came to.
 */
export function tuned(app: App, report: ParameterReport): void {
  const action = actionOf(app, report.project, report.action);

  if (action !== undefined) {
    action.tuning = report;
    action.refused = null;
  }
}

/**
 * Why a change to an Action's tuning was refused. What it is tuned to is left
 * exactly as it was, because a value the Action refused was never written down.
 */
export function refused(app: App, project: string, action: string, message: string): void {
  const state = actionOf(app, project, action);

  if (state !== undefined) {
    state.refused = message;
  }
}

/** What a Run said about itself, on the Action it belongs to. */
export function progressed(app: App, progress: Progress): void {
  const action = actionOf(app, progress.project, progress.action);

  if (action === undefined || progress.stage === "recorded" || progress.stage === "failed") {
    // How a Run ended is settled by the request ending, which carries the
    // command's whole answer rather than the last line of its progress.
    return;
  }

  action.doing = { stage: progress.stage, frames: progress.frames ?? null };
}

/**
 * How a request ended, across every Action it named.
 *
 * A Run that recorded hands over its own report, which is the Action's new
 * Latest. One that failed leaves the Latest exactly where it was -- a failed Run
 * took its own directory away with it, so the last good clip is still playable
 * and still what the stage plays.
 */
export function ended(app: App, request: Request): void {
  const ask = app.asked.get(request.id);
  const report = request.report;

  for (const run of runsIn(report)) {
    recorded(app, run);
  }

  for (const failure of failuresIn(report)) {
    blame(app, failure.project, failure.action, failure.message);
  }

  if (ask === undefined) {
    return;
  }

  // A request can fail without any Run reporting -- an Action nobody declared,
  // or a Project that is not configured -- and then what it named is what the
  // message is about.
  if (request.state === "failed" && failuresIn(report).length === 0) {
    for (const action of askedOf(app, ask)) {
      action.failure = request.message ?? "the Run failed without saying why";
    }
  }

  // Whatever it said, nothing it named is still recording.
  for (const action of askedOf(app, ask)) {
    action.doing = null;
  }
}

/** One Run that recorded, as the Latest of the Action it recorded. */
function recorded(app: App, run: Run): void {
  const action = actionOf(app, run.project, run.action);

  if (action === undefined) {
    return;
  }

  action.failure = null;

  // A Condition's Runs are a history of their own with a Latest of their own, so
  // the clip of the dark theme is not the Action's Latest however new it is.
  if (run.condition === null) {
    // The Latest, and what was the Latest is what it is now judged against. The
    // command prunes the far end of the history; nothing here reads that far.
    action.history = [run, ...action.history];
  }
}

function blame(app: App, project: string, action: string, message: string): void {
  const state = actionOf(app, project, action);

  if (state !== undefined) {
    state.failure = message;
  }
}

/**
 * The Runs a report carries: one Action's own report, or every Run a summary
 * says recorded. Which of the two arrived depends on what was asked for, so it
 * is read from the answer rather than remembered from the request.
 */
function runsIn(report: unknown): readonly Run[] {
  if (!isObject(report)) {
    return [];
  }
  if (Array.isArray((report as Partial<Summary>).runs)) {
    return (report as Summary).runs;
  }

  return Array.isArray((report as Partial<Run>).artifacts) ? [report as Run] : [];
}

/** The Runs a summary says failed, and none for a report of a single Run. */
function failuresIn(report: unknown): readonly Failure[] {
  if (!isObject(report) || !Array.isArray((report as Partial<Summary>).failures)) {
    return [];
  }

  return (report as Summary).failures;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
