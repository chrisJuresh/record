/**
 * The app, wired up: what it reads when it opens, what a button asks the server
 * for, and what an answer redraws.
 *
 * It is the CLI's operations and nothing else. Every button here is one request
 * to the server, which is one `record` command invoked on the other side of
 * loopback -- so there is no operation in the app that cannot be typed, and no
 * rule about Projects, Runs or Artifacts kept here to fall out of step.
 */
import * as api from "./api.js";
import {
  actionOf,
  actionsIn,
  asking,
  conditionsAsked,
  configuredWith,
  ended,
  judge,
  judgeAgainst,
  misconfigured,
  nothingYet,
  previewing,
  progressed,
  projectOf,
  refused,
  stood,
  tuned,
  unread,
  varyScheme,
  varyWidths,
  type ActionState,
  type App,
  type History,
  type ProjectState,
} from "./model.js";
import { close as closePreview, play, replay, showFrame } from "./player.js";
import {
  paint,
  paintConfiguration,
  paintMatrix,
  paintPreview,
  paintProgress,
  paintPublish,
  paintStanding,
  paintTuning,
  type Handlers,
} from "./view.js";

/** Where the rail's clips being on or off is remembered between openings. */
const railClipsKept = "record.rail-clips";

/**
 * How many of the command's answers are read at once while the app settles.
 *
 * Every answer is a `record` invocation, so reading a machine of five Projects
 * with ten Actions each would otherwise be fifty processes started at the same
 * moment -- which is the machine the Runs are about to want.
 */
const readsAtOnce = 4;

const root = pageRoot();
const app = nothingYet(remembered(railClipsKept) ?? true);

/**
 * What a change to one control is waiting on, so that two of them settle in the
 * order they were made -- an Action's tuning and a Project's settings alike.
 *
 * Adding a Project is not one of these. It reads the machine again when it
 * lands, and reading it asks what the Action on the stage is tuned to, which
 * would be a change queued behind the one it is waiting for.
 */
let writing: Promise<void> = Promise.resolve();

const handlers: Handlers = {
  choose(project, action) {
    app.chosen = { project, action };
    app.stage = { kind: "action" };
    // A Preview is of one Action, so choosing another gives the stage back to
    // that one's clips -- which is what a repaint does for itself.
    repaint();
    void readTuning(project, action);
    // ...and which Conditions it keeps Runs of, which is what the stage can be
    // asked to show. Read here rather than when the app opens, for the same
    // reason its tuning is: it is a command for the Action and one for each
    // Condition, and the machine has Runs to do.
    void readConditions(project, action);
  },

  showConfiguration(project) {
    app.stage = { kind: "configuration", project };
    repaint();
    void readConfiguration(project);
  },

  showNewProject() {
    app.stage = { kind: "new" };
    app.notConfigured = null;
    repaint();
  },

  showClips() {
    app.stage = { kind: "action" };
    repaint();
  },

  configure(project, name, value) {
    // Written into the file the Project is already configured in, and read back
    // from it: a setting the tool refuses was never written, so the controls go
    // back to what the file really says.
    void changing(project, () => api.configure(project, [`${name}=${value}`]));
  },

  add(name, settings) {
    void adding(name, settings);
  },

  runAction(project, action) {
    void ask({ project, action });
  },

  runProject(project) {
    void ask({ project });
  },

  runEverything() {
    void ask({ all: true });
  },

  varyScheme(scheme, on) {
    varyScheme(app, scheme, on);
    // Only what the Conditions come to: a box ticked changes what the next
    // press asks for and nothing that is on the stage, where a clip is playing.
    paintMatrix(app);
  },

  varyWidths(typed) {
    varyWidths(app, typed);
    paintMatrix(app);
  },

  judge(condition) {
    judge(app, condition);
    // A full paint, and deliberately: this is the one change in the app that is
    // meant to put new video elements in the page, because it is a change of
    // which clips are playing.
    repaint();
  },

  judgeAgainst(condition) {
    judgeAgainst(app, condition);
    repaint();
  },

  showRailClips(showing) {
    app.railClips = showing;
    remember(railClipsKept, showing);
    repaint();
  },

  tune(project, action, name, value) {
    // The Override is written before anything is recorded, so tuning survives a
    // Run that fails -- and it is what the next Run reads, whether it is asked
    // for here or typed (ADR 0005).
    void tuning(project, action, () => api.set(project, action, [`${name}=${String(value)}`]));
  },

  tryValue(project, action, name, value) {
    // Nothing is written: the Timeline is evaluated as if this applied, so that
    // a slider being dragged is a Preview changing rather than a sidecar
    // filling up with the forty values it passed through on the way.
    scrubbed(project, action, [`${name}=${String(value)}`]);
  },

  reset(project, action, name) {
    void tuning(project, action, () => api.reset(project, action, [name]));
  },

  showPreview(showing) {
    void previewed(showing);
  },

  playPreview(playing) {
    play(playing);
    paintPreview(app);
  },

  scrub(at) {
    // Scrubbing holds it where it was put, so that a travel that has settled
    // can be looked at rather than waited for to come round again.
    play(false);
    showFrame(at);
    paintPreview(app);
  },

  showPublish() {
    app.stage = { kind: "publish" };
    // Read again rather than kept: what is about to go public has to be what
    // this machine holds now, and a plan drawn from an older answer is a plan
    // somebody would be confirming blind.
    app.publish = null;
    app.notPublished = null;
    repaint();
    void publishing(() => api.publishPlan());
  },

  publish() {
    // The plan is what was read and this is the yes to it. Nothing else in the
    // app reaches off this machine (ADR 0007).
    void publishing(() => api.publish());
  },
};

repaint();
void settle();

/** The page the app is drawn into, which it is served inside. */
function pageRoot(): HTMLElement {
  const found = document.getElementById("app");

  if (found === null) {
    throw new Error("the app has no page to be drawn into");
  }

  return found;
}

/**
 * What the server says about this machine: every Project, every Action of each,
 * and the Latest of each Action -- which is the newest Run it still keeps.
 *
 * Read Project by Project and Action by Action rather than all or nothing. One
 * Action whose Runs cannot be read must not cost the rail every other Project:
 * an app claiming this machine has no Projects because one directory is unwell
 * is worse than an app saying which one it could not read.
 */
async function settle(): Promise<void> {
  let configured: readonly api.Project[];

  try {
    configured = await api.projects();
  } catch (failure) {
    // Nothing else is worth trying: what could not be read is the list of
    // Projects everything else would have been read against.
    app.trouble = messageOf(failure);
    repaint();
    return;
  }

  const troubles: string[] = [];

  app.projects = await eachAtOnce(configured, (project) => read(project, troubles));
  app.chosen = stillThere(app.chosen) ?? firstAction(app.projects);
  app.trouble = troubles.length === 0 ? null : troubles.join("\n");

  repaint();

  // ...which of them the Project has been committed to since, which is one
  // command for the whole workspace rather than one per Action...
  void readStanding();

  // ...and what the Action that landed on the stage is tuned to, which is read
  // for the one being looked at rather than for every Action there is.
  if (app.chosen !== null) {
    await readTuning(app.chosen.project, app.chosen.action);
    await readConditions(app.chosen.project, app.chosen.action);
  }
}

/** One Project's Actions, and the Runs each of them still keeps. */
async function read(project: api.Project, troubles: string[]): Promise<ProjectState> {
  let named: readonly string[] = [];

  try {
    named = await api.actions(project.name);
  } catch (failure) {
    // The Project is still listed, by the name it is configured under: it is
    // there, and what could not be read is what it declares.
    troubles.push(`'${project.name}': ${messageOf(failure)}`);
  }

  return {
    configured: project,
    // What the Project is at now is `record status`, which is asked for the
    // whole workspace once rather than Project by Project.
    commit: null,
    // ...and what it is configured with is read when it is asked for, since it
    // is the clips the app is opened for.
    configuration: null,
    misconfigured: null,
    actions: await eachAtOnce(named, (action) => readAction(project.name, action, troubles)),
  };
}

async function readAction(
  project: string,
  action: string,
  troubles: string[],
): Promise<ActionState> {
  const idle = {
    project,
    action,
    // Which Conditions it has been recorded under is read when it reaches the
    // stage, and nothing is a different answer from an Action that keeps none.
    conditions: null,
    stale: false,
    doing: null,
    failure: null,
    tuning: null,
    refused: null,
  };

  try {
    // Newest first, so the Latest is the first of them and the Run it is judged
    // against is the second -- and an Action nobody has run keeps none at all,
    // which is a state rather than a failure.
    return { ...idle, history: await api.history(project, action) };
  } catch (failure) {
    // Listed by name with nothing to play, which is what it is: whether it has
    // ever recorded is exactly what could not be read.
    troubles.push(`'${project} ${action}': ${messageOf(failure)}`);

    return { ...idle, history: [] };
  }
}

/**
 * Which Actions the Project has been committed to since, and what could not be
 * told either way.
 *
 * Written into the flags already on the page rather than by drawing it again:
 * this is read when the app opens and as every request ends, and by then there
 * are clips playing on the stage that a repaint would restart.
 */
async function readStanding(): Promise<void> {
  try {
    stood(app, await api.status());
  } catch (failure) {
    // Staleness unread is not staleness absent, so what could not be read is
    // said rather than left as an app whose Actions all read as current. Said
    // where staleness is said, since this arrives while the clips are playing
    // too -- and the flags are left exactly as they were.
    unread(app, messageOf(failure));
  }

  paintStanding(app);
}

/**
 * What the Action on the stage declares and is tuned to.
 *
 * Read when it reaches the stage rather than when the app opens: answering this
 * imports the Action's module, and importing every Action of every Project to
 * show one of them is work nobody asked for. Read once and kept, since the
 * sidecar changes only through the app itself.
 */
async function readTuning(project: string, action: string): Promise<void> {
  const state = actionOf(app, project, action);

  if (state === undefined || state.tuning !== null) {
    return;
  }

  await tuning(project, action, () => api.parameters(project, action));
}

/**
 * Reads or writes one Action's tuning, and draws what the command answered.
 *
 * A refusal is kept against the Action in the command's own words, and what the
 * Action is tuned to is left exactly as it was: a value it would not take was
 * never written down, so the controls go back to what is really in the sidecar.
 */
function tuning(
  project: string,
  action: string,
  ask: () => Promise<api.ParameterReport>,
): Promise<void> {
  return oneAtATime(async () => {
    try {
      tuned(app, await ask());
    } catch (failure) {
      refused(app, project, action, messageOf(failure));
    }

    // Only the Parameters and the Preview: a clip is playing beside them, and a
    // value nudged must not put a new video element in the page -- nor a new
    // frame, where the Preview has taken their place.
    paintTuning(app);
    scrubbed(project, action, []);
  });
}

/**
 * The Conditions the Action on the stage keeps Runs of, and the Runs of each.
 *
 * Read when it reaches the stage rather than when the app opens, like its
 * tuning: a Condition is declared nowhere -- it is whatever a Matrix has been
 * asked for -- so finding out is one command for the Action and one more for
 * every Condition it answers with, and asking that of every Action of every
 * Project to draw one of them is work nobody asked for.
 *
 * Read once and kept. What a Run adds is the Run itself, which arrives at the
 * head of the stream it recorded into when the request ends.
 */
async function readConditions(project: string, action: string): Promise<void> {
  const state = actionOf(app, project, action);

  if (state === undefined || state.conditions !== null) {
    return;
  }

  let named: readonly string[];

  try {
    named = await api.conditions(project, action);
  } catch (failure) {
    // Left unread rather than recorded as none: an Action whose Conditions
    // could not be listed is not an Action without any, and choosing it again
    // is what asks a second time.
    app.trouble = `'${project} ${action}': ${messageOf(failure)}`;
    repaint();
    return;
  }

  const troubles: string[] = [];
  const histories = await eachAtOnce(named, (condition) =>
    readCondition(project, action, condition, troubles),
  );

  const settled = actionOf(app, project, action);

  if (settled === undefined) {
    return;
  }

  settled.conditions = histories;
  app.trouble = troubles.length === 0 ? app.trouble : troubles.join("\n");

  // Nothing on the stage changes for an Action that keeps none, and a Preview
  // has the stage in place of the clips -- taking that down is a paint of its
  // own, and the picker is drawn by it.
  if (histories.length > 0 && app.preview === null) {
    repaint();
  }
}

/** One Condition's Runs, newest first, or the Condition with none where they could not be read. */
async function readCondition(
  project: string,
  action: string,
  condition: string,
  troubles: string[],
): Promise<History> {
  try {
    return { condition, runs: await api.history(project, action, condition) };
  } catch (failure) {
    // Named with nothing to play, which is what it is: the Condition is there,
    // and what could not be read is what it has kept.
    troubles.push(`'${project} ${action} ${condition}': ${messageOf(failure)}`);

    return { condition, runs: [] };
  }
}

/**
 * Turns a Preview on, or gives the stage back to the clips.
 *
 * Turning it on is one request: the command refuses an Action that clicks,
 * types, evaluates or waits, and a Project that is not answering -- and the
 * refusal is said on the stage in the command's own words. Nothing here
 * decides either.
 */
async function previewed(on: boolean): Promise<void> {
  const chosen = app.chosen;

  if (!on || chosen === null) {
    takeThePreviewDown();
    repaint();
    return;
  }

  app.preview = {
    project: chosen.project,
    action: chosen.action,
    origin: null,
    timeline: null,
    trouble: null,
  };
  draw();

  try {
    const turned = await api.preview(chosen.project, chosen.action);
    const preview = app.preview;

    if (preview === null || preview.project !== turned.project || preview.action !== turned.action) {
      return;
    }

    preview.origin = turned.origin;
    preview.timeline = turned.timeline;
  } catch (failure) {
    // "it clicks in the running Project" and "your site is not up" are
    // different problems with different next steps, and only the command knows
    // which of them happened.
    if (app.preview !== null) {
      app.preview.trouble = messageOf(failure);
    }
  }

  // A paint rather than a write: this is where the frame the Project is played
  // in reaches the stage, and it is created exactly once.
  draw();
}

/** Takes the Preview off the stage, which is what gives the clips it back. */
function takeThePreviewDown(): void {
  app.preview = null;
  closePreview();
}

/**
 * What the Preview is waiting on, so that a slider dragged across its range is
 * one evaluation at a time rather than sixty processes a second. The latest
 * value wins, because the one being asked about is the one under the cursor.
 */
let evaluating = false;
let toEvaluate: readonly string[] | null = null;

/**
 * Plays the Preview under a value that has not been settled on -- or under the
 * sidecar as it now stands, which is what a settled one comes to.
 *
 * Nothing is written either way. This is the whole of the difference between
 * scrubbing and tuning: the app asks for evaluations continuously while a
 * control is moving, and writes an Override only when the person lets go, which
 * is the existing write path unchanged (ADR 0005).
 */
function scrubbed(project: string, action: string, named: readonly string[]): void {
  const preview = previewing(app);

  if (preview === undefined || preview.project !== project || preview.action !== action) {
    return;
  }

  toEvaluate = named;
  void evaluatingLatest(project, action);
}

async function evaluatingLatest(project: string, action: string): Promise<void> {
  if (evaluating) {
    return;
  }
  evaluating = true;

  try {
    while (toEvaluate !== null) {
      const named = toEvaluate;
      toEvaluate = null;
      await evaluate(project, action, named);
    }
  } finally {
    evaluating = false;
  }
}

async function evaluate(
  project: string,
  action: string,
  named: readonly string[],
): Promise<void> {
  const preview = app.preview;

  if (preview === null || preview.project !== project || preview.action !== action) {
    return;
  }

  try {
    const evaluated = await api.timeline(project, action, named);

    preview.timeline = evaluated;
    preview.trouble = null;
    // It keeps playing while the states are swapped, because the change and the
    // motion have to be the same event.
    replay(evaluated);
  } catch (failure) {
    preview.trouble = messageOf(failure);
  }

  paintPreview(app);
}

/**
 * What one Project is configured with, read when its configuration reaches the
 * stage. Read once and kept, since the file changes only through the app --
 * and a setting changed by hand while the app is open is what re-opening it is
 * for.
 */
async function readConfiguration(project: string): Promise<void> {
  const state = projectOf(app, project);

  if (state === undefined || state.configuration !== null) {
    return;
  }

  await changing(project, () => api.configuration(project));
}

/**
 * Reads or changes one Project's configuration, and draws what the command
 * answered.
 *
 * A refusal is kept against the Project in the command's own words, and what it
 * is configured with is left exactly as it was: the file was never written, so
 * the controls go back to what it really says.
 */
function changing(project: string, ask: () => Promise<api.ProjectReport>): Promise<void> {
  return oneAtATime(async () => {
    try {
      configuredWith(app, await ask());
    } catch (failure) {
      misconfigured(app, project, messageOf(failure));
    }

    paintConfiguration(app);
  });
}

/**
 * Reads what publishing would make public, or carries that plan out.
 *
 * Both answer with the same report, so the panel is drawn the same way whether
 * it is showing what would happen or what did -- and a refusal is kept in the
 * command's own words, since "not a git repository" and "the clips were
 * committed and the push failed" are different problems with different next
 * steps.
 *
 * Only this panel is redrawn: the rail beside it is full of clips, and reading
 * what is about to go public must not restart them.
 */
async function publishing(ask: () => Promise<api.PublishReport>): Promise<void> {
  app.publishing = true;
  app.notPublished = null;
  paintPublish(app);

  try {
    app.publish = await ask();
  } catch (failure) {
    app.notPublished = messageOf(failure);
  }

  app.publishing = false;
  paintPublish(app);
}

/**
 * Configures a Project this machine does not have yet, and opens what it is
 * configured with -- which is where the rest of it is filled in.
 *
 * What the app knows about this machine is read again rather than added to: a
 * Project that was not there is Actions, Runs and staleness the app has never
 * asked about.
 */
async function adding(name: string, settings: readonly string[]): Promise<void> {
  let added: api.ProjectReport;

  try {
    added = await api.add(name, settings);
  } catch (failure) {
    // Said beside the form rather than drawn over it: what was typed into the
    // rest of it is what the next attempt is made of.
    app.notConfigured = messageOf(failure);
    paintConfiguration(app);
    return;
  }

  app.notConfigured = null;
  app.stage = { kind: "configuration", project: added.project };

  await settle();

  configuredWith(app, added);
  repaint();
}

/**
 * Runs one piece of tuning at a time, in the order it was asked for.
 *
 * A slider let go of twice in quick succession is two Overrides written to one
 * sidecar, and the answers are two reports of what the Action will run with.
 * Unsequenced, the slower of them lands last and the controls end up drawn from
 * the older answer -- reading as though the second change had not happened.
 */
function oneAtATime(work: () => Promise<void>): Promise<void> {
  writing = writing.then(work, work);

  return writing;
}

/**
 * Reads them a few at a time, answering in the order they were asked about. The
 * same shape the tool records Actions in, and for the same reason: the machine
 * running this has Runs to do.
 */
async function eachAtOnce<Item, Answer>(
  items: readonly Item[],
  read: (item: Item) => Promise<Answer>,
): Promise<Answer[]> {
  const answers: Answer[] = [];
  const queue = items.entries();

  const worker = async (): Promise<void> => {
    for (const [at, item] of queue) {
      answers[at] = await read(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(readsAtOnce, items.length) }, worker));

  return answers;
}

/**
 * The Action on the stage, where it is still one of the Actions there are --
 * reading the machine again must not move the stage out from under whoever was
 * watching a clip on it.
 */
function stillThere(chosen: App["chosen"]): App["chosen"] {
  return chosen !== null && actionOf(app, chosen.project, chosen.action) !== undefined
    ? chosen
    : null;
}

/** The Action the app opens on, which is the first one there is. */
function firstAction(projects: readonly ProjectState[]): App["chosen"] {
  for (const project of projects) {
    const action = project.actions[0];

    if (action !== undefined) {
      return { project: action.project, action: action.action };
    }
  }

  return null;
}

/**
 * Asks the server to record, and watches what happens.
 *
 * The request is answered as soon as it has been asked for, because a Run takes
 * long enough that waiting for it would be the hang this is meant to prevent.
 * What each Run is doing arrives as it does it, and how the request ended
 * carries the command's whole answer -- the Runs that recorded, which are the
 * new Latest, and what stopped the ones that did not.
 */
async function ask(what: api.Ask): Promise<void> {
  // Every one of the three record buttons carries the Conditions, because a
  // Matrix is a way of asking for Runs rather than a fourth kind of request.
  const asked = { ...what, ...conditionsAsked(app) };
  let begun: api.Request;

  try {
    begun = await api.record(asked);
  } catch (failure) {
    app.trouble = messageOf(failure);
    repaint();
    return;
  }

  app.asked.set(begun.id, asked);
  app.trouble = null;
  asking(app, asked);
  repaint();

  api.watch(begun.id, {
    progress(progress) {
      progressed(app, progress);
      // Only what a Run says about itself, and not the page it says it on: a
      // Frame arrives sixty times a second, and the clip on the stage is being
      // watched while they do.
      paintProgress(app);
    },

    ended(request) {
      ended(app, request);
      app.asked.delete(request.id);
      repaint();

      // A Run that recorded against the Project as it stands now is no longer
      // Stale, and which Actions are is the command's answer rather than
      // something worked out from the Run that just landed.
      void readStanding();

      // A Matrix records into streams the app may never have asked about. Runs
      // of a stream it has read are already at the head of it; this is for the
      // Action whose Conditions were never read at all, and it asks nothing
      // where they have been.
      if (app.chosen !== null) {
        void readConditions(app.chosen.project, app.chosen.action);
      }
    },

    lost() {
      if (!app.asked.has(begun.id)) {
        return;
      }

      // The Run itself is unaffected -- it is the command's, not the page's --
      // so what is lost is only knowing about it. What it produced is read back
      // by asking again.
      app.asked.delete(begun.id);
      app.trouble = "the server stopped saying what that Run was doing";

      for (const action of actionsIn(app)) {
        action.doing = null;
      }

      void settle();
    },
  });
}

/**
 * Draws the whole app, and takes any Preview down on the way.
 *
 * A full paint replaces everything under the stage, and moving the frame a
 * Preview is played in reloads the Project inside it -- so no Preview survives
 * one, and pretending otherwise would reload somebody's site under them at the
 * moment they pressed Run.
 *
 * The rule is written here rather than at each of the buttons that cause a
 * paint, because it is about painting rather than about any of them: a Preview
 * takes the stage in place of the clips, and anything that redraws the stage
 * gives it back to them.
 */
function repaint(): void {
  takeThePreviewDown();
  draw();
}

/**
 * ...and a full paint that keeps it, which is only ever turning one on: this is
 * where the frame reaches the stage, and it is created exactly once.
 */
function draw(): void {
  paint(root, app, handlers);
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** Whether the rail showed clips last time, or nothing where it has not run before. */
function remembered(name: string): boolean | undefined {
  try {
    const kept = localStorage.getItem(name);

    return kept === null ? undefined : kept === "true";
  } catch {
    // A browser refusing storage is a preference nobody remembers, which is not
    // a reason for the app not to open.
    return undefined;
  }
}

function remember(name: string, value: boolean): void {
  try {
    localStorage.setItem(name, String(value));
  } catch {
    return;
  }
}
