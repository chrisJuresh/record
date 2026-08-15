/**
 * The page, drawn from the state.
 *
 * Everything is built as elements and given its text, never as markup: a Project
 * is named after a directory and an Action after a file, and a failure carries
 * whatever the command said. None of those are things a page should be able to
 * be written by.
 *
 * There are five ways in. `paint` draws the whole app, and is what a choice, a
 * request or a new Latest costs. `paintProgress` writes into the handful of nodes
 * a Run in flight changes -- because a Run says something every Frame, and
 * redrawing a stage sixty times a second would take the clip out from under
 * whoever is watching it. `paintStanding` writes the Stale flags, for the same
 * reason: they are read again as every request ends, and by then there are two
 * clips playing that a repaint would restart. `paintTuning` and
 * `paintConfiguration` draw the controls a value was just written from, and
 * nothing else on the page they sit on.
 */
import {
  artifactUrl,
  embedUrl,
  type Artifact,
  type Parameter,
  type ParameterSetting,
  type PublishedAction,
  type PublishedProject,
  type PublishPlan,
  type PublishReport,
  type Run,
  type Setting,
} from "./api.js";
import {
  actionsIn,
  chosenAction,
  chosenProject,
  configuring,
  latestOf,
  playing,
  previewing,
  colourSchemes,
  previousOf,
  recording,
  varied,
  type ActionState,
  type App,
  type Doing,
  type Preview,
  type ProjectState,
} from "./model.js";
import { playerFor, refit, showing, type Showing } from "./player.js";

export type Handlers = {
  choose(project: string, action: string): void;
  runAction(project: string, action: string): void;
  runProject(project: string): void;
  runEverything(): void;
  /**
   * Records across this colour scheme as well, or stops doing so -- a Condition
   * each, and so a Run each. None of them ticked is the plain Run every one of
   * those three buttons asked for before this existed.
   */
  varyScheme(scheme: string, on: boolean): void;
  /** ...and across these viewport widths, exactly as they were typed. */
  varyWidths(typed: string): void;
  showRailClips(showing: boolean): void;
  /** Overrides one Parameter of one Action, by the value it is to take. */
  tune(project: string, action: string, name: string, value: ParameterSetting): void;
  /**
   * ...and a value that is still being dragged: the Preview is re-evaluated as
   * if it applied and nothing is written, so that scrubbing a slider does not
   * leave forty Overrides behind it in the sidecar.
   */
  tryValue(project: string, action: string, name: string, value: ParameterSetting): void;
  /** Removes that Override, leaving what the Action declares. */
  reset(project: string, action: string, name: string): void;
  /** Puts the Action played live against the running Project on the stage, or takes it off. */
  showPreview(showing: boolean): void;
  /** Plays the Preview, looping, or holds it where it has been scrubbed to. */
  playPreview(playing: boolean): void;
  /** Shows one Frame of it, which is what scrubbing to a moment does. */
  scrub(at: number): void;
  /** Puts what one Project is configured with on the stage, in place of the clips. */
  showConfiguration(project: string): void;
  /** ...and the form a Project this machine does not have yet is configured from. */
  showNewProject(): void;
  /** Back to the clips, which is what the stage is for the rest of the time. */
  showClips(): void;
  /**
   * Changes one setting of one Project, by the value it is to take -- written
   * as the command writes it, since nothing given a value here is worth
   * spelling twice. Nothing at all takes the setting out of the file.
   */
  configure(project: string, name: string, value: string): void;
  /** Configures a Project this machine does not have yet, which is never Published. */
  add(project: string, settings: readonly string[]): void;
  /** Puts what publishing would make public on the stage, which is where it is confirmed. */
  showPublish(): void;
  /** Carries that plan out: this repository committed and pushed, and nothing else. */
  publish(): void;
};

/** Which of the two Runs on the stage a clip is, which is what it is headed by. */
type Which = "Latest" | "Previous";

/** What the rail says about one Action without being drawn again. */
type Marks = {
  /** How far through its Run is, or that its last one failed. */
  readonly badge: HTMLElement;
  /** That its Project has been committed to since it last ran. */
  readonly flag: HTMLElement;
};

/** The nodes a Run in flight writes into, kept from the last full paint. */
type Live = {
  readonly tally: HTMLElement;
  /** How many Runs of each Action the ticked Conditions come to. */
  readonly matrix: HTMLElement;
  /** The rail's marks, by the Action they belong to. */
  readonly marks: Map<string, Marks>;
  /** Where the rail says a Project is Published, by the Project it says it of. */
  readonly published: Map<string, HTMLElement>;
  /** Where the stage says the Action on it has gone Stale. */
  readonly standing: HTMLElement;
  /** Where the Run of the Action on the stage says what it is doing. */
  readonly progress: HTMLElement;
  /** Disabled while the Action it records is already recording. */
  readonly runAction: HTMLButtonElement | null;
  /** The Parameters of the Action on the stage, which tuning redraws on its own. */
  readonly parameters: HTMLElement;
  /** What one Project is configured with, which changing a setting redraws. */
  readonly configuration: HTMLElement;
  /** Where that is written down, which is not known until it has been read. */
  readonly where: HTMLElement;
  /** Why a Project the app was asked to add was not configured. */
  readonly notConfigured: HTMLElement;
  /**
   * What is drawn above and below the Preview. Two nodes rather than one around
   * it, because moving an iframe in the document reloads it -- the frame is put
   * on the stage once and everything that surrounds it is redrawn around it.
   */
  readonly previewAbove: HTMLElement;
  readonly previewBelow: HTMLElement;
  /** Which Frame is showing, written into sixty times a second and never drawn. */
  readonly previewFrame: HTMLElement;
  /** What publishing would make public, which reading and confirming both redraw. */
  readonly publish: HTMLElement;
  /** What the controls in there call, since they are drawn again without a paint. */
  readonly handlers: Handlers;
};

let live: Live | undefined;

/** Where a Preview is scrubbed from, so that playing it can move the control. */
let scrubbing: HTMLInputElement | undefined;

/** Draws the whole app. */
export function paint(root: HTMLElement, app: App, handlers: Handlers): void {
  const marks = new Map<string, Marks>();
  const published = new Map<string, HTMLElement>();
  const tally = el("span", { class: "faint" }, [tallyOf(app)]);
  const matrix = el("span", { class: "faint num" });
  const standing = el("div", { class: "standing" });
  const progress = el("div", { class: "progress" });
  const parameters = el("aside", { class: "params" });
  const configuration = el("div", { class: "settings" });
  const where = el("span", { class: "muted" });
  const notConfigured = el("div", { class: "not-configured" });
  const publish = el("div", { class: "publish" });
  const previewAbove = el("div", { class: "preview-above" });
  const previewBelow = el("div", { class: "preview-below" });
  const previewFrame = el("span", { class: "faint num" });

  const chosen = playing(app);
  const runAction =
    chosen === undefined
      ? null
      : button("Run Action", "act primary", () => handlers.runAction(chosen.project, chosen.action));

  root.replaceChildren(
    topbar(app, handlers, tally, matrix),
    el("div", { class: "body" }, [
      rail(app, handlers, marks, published),
      stage(app, handlers, {
        standing,
        progress,
        runAction,
        configuration,
        where,
        publish,
        previewAbove,
        previewBelow,
      }),
      parameters,
    ]),
    // The one way out of this machine, at the bottom of the page: everything
    // above it happens here, and this is the button that does not.
    footbar(app, handlers),
  );

  live = {
    tally,
    matrix,
    marks,
    published,
    standing,
    progress,
    runAction,
    parameters,
    configuration,
    where,
    notConfigured,
    publish,
    previewAbove,
    previewBelow,
    previewFrame,
    handlers,
  };
  paintProgress(app);
  paintMatrix(app);
  paintStanding(app);
  paintTuning(app);
  // Drawn rather than left empty: these are the two that put a whole panel on
  // the stage rather than writing into one already there.
  paintConfiguration(app);
  paintPublish(app);
  paintPreview(app);
}

/**
 * Draws what surrounds the Preview, and never the Preview itself.
 *
 * Its own paint because tuning redraws the Parameter column and the Preview and
 * nothing else -- and because the frame the Project is played in is created
 * once and only ever messaged afterwards. A Parameter change must not put a new
 * frame in the page any more than a slider let go of may put a new video
 * element in it.
 */
export function paintPreview(app: App): void {
  if (live === undefined) {
    return;
  }

  const preview = previewing(app);

  if (preview === undefined) {
    live.previewAbove.replaceChildren();
    live.previewBelow.replaceChildren();
    scrubbing = undefined;
    return;
  }

  live.previewAbove.replaceChildren(...previewHead(preview, live.handlers));
  live.previewBelow.replaceChildren(...previewFoot(preview, live.handlers, live.previewFrame));
  // Measured now the frame is on the page: an element that has not been drawn
  // yet has no width for the Project's viewport to be scaled against.
  refit();
  frameShowing(showing());
}

/**
 * Says which Frame the Preview is showing, and moves the scrub with it. Written
 * into rather than drawn: a Frame arrives sixty times a second, and redrawing
 * the stage at that rate would take the Preview out from under whoever is
 * watching it.
 */
export function frameShowing(said: Showing | null): void {
  if (live === undefined || said === null) {
    return;
  }

  live.previewFrame.textContent = `Frame ${said.at + 1} of ${said.of}`;

  if (scrubbing !== undefined && document.activeElement !== scrubbing) {
    scrubbing.value = String(said.at);
  }
}

/**
 * Says how many Runs of each Action the ticked Conditions come to, and nothing
 * else.
 *
 * Its own paint because a box ticked changes only what the buttons will ask
 * for: the clips are playing beside it, and neither a scheme nor a width may
 * put a new video element in the page. The controls are left alone as well as
 * the clips -- they already hold what was ticked and typed, and redrawing the
 * box being typed into would take the caret out of it. A full paint does
 * rebuild them, from the same state, which is why it is the thing a change
 * here deliberately is not.
 */
export function paintMatrix(app: App): void {
  if (live === undefined) {
    return;
  }

  live.matrix.textContent = matrixSays(app);
}

/**
 * Draws what publishing would make public, and nothing else.
 *
 * Its own paint because it is read and then confirmed: pressing the button
 * redraws the plan into the outcome without taking the page it is on apart, and
 * a plan being read must not restart the clips in the rail beside it.
 */
export function paintPublish(app: App): void {
  if (live === undefined) {
    return;
  }

  live.publish.replaceChildren(...publishIn(app, live.handlers));
}

/**
 * Writes which Actions the Project has been committed to since into the flags
 * already on the page, and says on the stage what that means for the Action on
 * it -- along with whatever the command could not tell either way.
 *
 * Staleness is read when the app opens and again as every request ends, so it is
 * its own paint: two clips are playing on the stage by then, and neither of them
 * should restart because a word beside them changed.
 */
export function paintStanding(app: App): void {
  if (live === undefined) {
    return;
  }

  for (const action of actionsIn(app)) {
    const marks = live.marks.get(keyOf(action.project, action.action));

    if (marks !== undefined) {
      marks.flag.textContent = action.stale ? "stale" : "";
    }
  }

  live.standing.replaceChildren(...standingOf(app));
}

/**
 * Draws the Parameters of the Action on the stage, and nothing else.
 *
 * Tuning is its own paint because a clip is playing beside it: a slider let go
 * of would otherwise take the video out of the page and put a new one back,
 * which reads as the clip restarting every time a value is nudged.
 */
export function paintTuning(app: App): void {
  if (live === undefined) {
    return;
  }

  live.parameters.replaceChildren(...tuningIn(app, live.handlers));
}

/**
 * Draws what the Project on the stage is configured with, and nothing else.
 *
 * A Project being added is a form somebody is halfway through typing into, so
 * what was refused is written beside it rather than the form drawn again --
 * redrawing it would take back what they had typed. A Project that exists is
 * drawn from the report the command just gave, which is what its file now says.
 */
export function paintConfiguration(app: App): void {
  if (live === undefined) {
    return;
  }

  live.where.textContent = whereOf(app);

  if (app.stage.kind === "new" && live.configuration.contains(live.notConfigured)) {
    live.notConfigured.replaceChildren(...notConfiguredIn(app));
    return;
  }

  live.configuration.replaceChildren(
    ...configurationIn(app, live.handlers, live.notConfigured),
  );

  // ...and the rail says which Projects are Published, which is a setting that
  // was possibly just changed. Written into the pill already there rather than
  // drawn again: the rail is full of clips that a repaint would restart.
  for (const project of app.projects) {
    const pill = live.published.get(project.configured.name);

    if (pill !== undefined) {
      pill.textContent = project.configured.published ? "published" : "";
    }
  }
}

/**
 * Writes what every Run in flight is doing into the nodes already on the page.
 * Nothing here adds or removes anything, so a Frame arriving changes a word.
 */
export function paintProgress(app: App): void {
  if (live === undefined) {
    return;
  }

  live.tally.textContent = tallyOf(app);

  for (const action of actionsIn(app)) {
    const marks = live.marks.get(keyOf(action.project, action.action));

    if (marks !== undefined) {
      const says = badgeOf(action);

      marks.badge.textContent = says.text;
      marks.badge.className = says.failed ? "badge failed" : "badge num";
    }
  }

  const chosen = chosenAction(app);

  if (live.runAction !== null) {
    live.runAction.disabled = chosen?.doing != null;
  }

  live.progress.replaceChildren(...(chosen?.doing == null ? [] : inFlight(chosen.doing)));
}

function topbar(
  app: App,
  handlers: Handlers,
  tally: HTMLElement,
  matrix: HTMLElement,
): HTMLElement {
  const railClips = button(
    app.railClips ? "Hide clips in rail" : "Show clips in rail",
    "act quiet",
    () => handlers.showRailClips(!app.railClips),
  );

  return el("header", { class: "topbar" }, [
    el("span", { class: "wordmark" }, ["record"]),
    tally,
    el("span", { class: "spacer" }),
    conditions(app, handlers, matrix),
    railClips,
    button("Run everything", "act primary", () => handlers.runEverything()),
  ]);
}

/**
 * The Conditions every record button records across, drawn where the button
 * that records everything is -- the three of them ask for one request each, and
 * the Conditions belong to the request rather than to any one of the buttons.
 *
 * Ticked here rather than declared in a Project's settings, deliberately: see
 * `Matrix`. Nothing is remembered between openings for the same reason, so a
 * Matrix is asked for by somebody who meant to ask for one.
 */
function conditions(app: App, handlers: Handlers, says: HTMLElement): HTMLElement {
  const widths = el("input", {
    id: "matrix-widths",
    class: "typed num",
    type: "text",
    placeholder: "480,900",
    value: app.matrix.widths,
  });

  // As it is typed rather than when the box is left: nothing is written
  // anywhere, and what this changes is what the next press would ask for.
  widths.addEventListener("input", () => handlers.varyWidths(widths.value));

  return el("div", { class: "conditions" }, [
    el("span", { class: "faint" }, ["record in"]),
    ...colourSchemes.map((scheme) =>
      schemeBox(scheme, app.matrix.schemes.includes(scheme), (on) =>
        handlers.varyScheme(scheme, on),
      ),
    ),
    el("label", { class: "faint", for: "matrix-widths" }, ["at widths"]),
    widths,
    says,
  ]);
}

/** One colour scheme to record across, ticked by the name it is recorded under. */
function schemeBox(scheme: string, ticked: boolean, tick: (on: boolean) => void): HTMLElement {
  const box = el("input", { id: `matrix-${scheme}`, type: "checkbox" });

  box.checked = ticked;
  box.addEventListener("change", () => tick(box.checked));

  return el("label", { class: "ticking" }, [box, scheme]);
}

/**
 * That a press is now a Matrix, said before it is pressed rather than found out
 * from a summary afterwards: it is a Run per Condition however few Actions it
 * names, and that is worth having meant.
 *
 * ...and that they are kept apart, because every Condition keeps a Latest and a
 * history of its own -- so the clips on the stage stay exactly where they are
 * while a Matrix records, and a stage that did not say so would read as a Run
 * that produced nothing. How many Runs that comes to is the command's
 * arithmetic, and is reported by the summary that carried it out.
 */
function matrixSays(app: App): string {
  return varied(app) ? "a Run per Condition, kept apart from each Action's own" : "";
}

/**
 * The bottom of the page: the one button that reaches off this machine.
 *
 * It is one button rather than a per-Project one, because publishing is one
 * operation over everything Published -- and it opens the plan rather than
 * publishing, since what goes public is read before it is agreed to.
 */
function footbar(app: App, handlers: Handlers): HTMLElement {
  return el("footer", { class: "footbar" }, [
    el("span", { class: "faint" }, [
      "Publishing copies the Latest clips of every Published Project into this repository, " +
        "commits them and pushes it.",
    ]),
    el("span", { class: "spacer" }),
    button(
      "Publish",
      `act primary${app.stage.kind === "publish" ? " selected" : ""}`,
      () => handlers.showPublish(),
    ),
  ]);
}

/** How much there is, and how much of it is recording. */
function tallyOf(app: App): string {
  const actions = actionsIn(app);
  const busy = recording(app);

  return [
    `${many(app.projects.length, "Project")} · ${many(actions.length, "Action")}`,
    ...(busy === 0 ? [] : [`${busy} recording`]),
  ].join(" · ");
}

/** A section per Project, its Actions listed by name under it. */
function rail(
  app: App,
  handlers: Handlers,
  marks: Map<string, Marks>,
  published: Map<string, HTMLElement>,
): HTMLElement {
  return el("nav", { class: "rail" }, [
    ...app.projects.flatMap((project) => [
      railProject(app, handlers, project, published),
      ...(project.actions.length === 0
        ? [el("div", { class: "absent none" }, ["no Actions"])]
        : project.actions.map((action) => railAction(app, handlers, action, marks))),
    ]),
    // A Project is configured from here as well as recorded from here, so that
    // adding one is not a file somebody has to remember the shape of.
    el("div", { class: "rail-foot" }, [
      button("Add a Project", "act quiet", () => handlers.showNewProject()),
    ]),
  ]);
}

/**
 * One Project in the rail: its name, whether it is Published, and the way to
 * what it is configured with -- which is where publishing is turned on.
 */
function railProject(
  app: App,
  handlers: Handlers,
  project: ProjectState,
  published: Map<string, HTMLElement>,
): HTMLElement {
  const name = project.configured.name;
  const pill = el("span", { class: "pill published" }, [
    project.configured.published ? "published" : "",
  ]);

  published.set(name, pill);

  const chosen =
    app.stage.kind === "configuration" && app.stage.project === name ? " selected" : "";

  return el("div", { class: "project" }, [
    el("span", {}, [name]),
    pill,
    el("span", { class: "spacer" }),
    button("settings", `act tiny${chosen}`, () => handlers.showConfiguration(name)),
  ]);
}

function railAction(
  app: App,
  handlers: Handlers,
  action: ActionState,
  marks: Map<string, Marks>,
): HTMLElement {
  const badge = el("span", { class: "badge num" });
  // Flagged in the rail rather than only on the stage: an Action gone Stale is
  // one to go and look at, and one that has to be opened to find that out is one
  // nobody finds out about.
  const flag = el("span", { class: "pill stale" });

  marks.set(keyOf(action.project, action.action), { badge, flag });

  const chosen =
    app.chosen?.project === action.project && app.chosen.action === action.action ? " selected" : "";

  const row = el("span", { class: "row" }, [
    el("span", { class: "name" }, [action.action]),
    flag,
    badge,
  ]);

  return button(
    "",
    `action${chosen}`,
    () => handlers.choose(action.project, action.action),
    [row, ...(app.railClips ? [railClip(action)] : [])],
  );
}

/**
 * A clip of the Action under its name, which is what makes the rail readable as
 * "the one I meant" -- the GIF, because it plays without being asked to.
 */
function railClip(action: ActionState): HTMLElement {
  const latest = latestOf(action);
  const gif = latest === null ? undefined : artifactOf(latest, "gif");

  if (latest === null || gif === undefined) {
    return el("span", { class: "absent" }, ["not recorded yet"]);
  }

  // Fetched as the rail is drawn rather than as it is scrolled: these are files
  // on this machine, and a rail whose clips arrive only once something has
  // scrolled is a rail that reads as empty.
  const image = el("img", {
    class: "gif",
    src: artifactUrl(latest, gif),
    alt: `The Latest clip of ${action.action}`,
  });
  // What the clip's shape is, so the rail reserves the room the GIF will take
  // rather than jumping when it arrives. It is drawn at the rail's width.
  image.width = gif.width;
  image.height = gif.height;

  return image;
}

/** The nodes on the stage that are written into rather than drawn again. */
type Written = {
  readonly standing: HTMLElement;
  readonly progress: HTMLElement;
  readonly runAction: HTMLButtonElement | null;
  readonly configuration: HTMLElement;
  readonly where: HTMLElement;
  readonly publish: HTMLElement;
  readonly previewAbove: HTMLElement;
  readonly previewBelow: HTMLElement;
};

/** The Action on the stage: what it last produced, and what it can be asked for. */
function stage(app: App, handlers: Handlers, written: Written): HTMLElement {
  const { standing, progress, runAction, configuration, where, publish } = written;
  const trouble = app.trouble === null ? [] : [troublePanel("The app", app.trouble)];

  // What is about to go public takes the stage too, and for a stronger reason
  // than configuration does: it is read in full before it is confirmed.
  if (app.stage.kind === "publish") {
    return el("section", { class: "stage" }, [
      ...trouble,
      el("div", { class: "stage-head" }, [
        el("h2", {}, ["Publish"]),
        el("span", { class: "muted" }, ["this repository, and nothing else"]),
        el("span", { class: "spacer" }),
        button("Back to the clips", "act", () => handlers.showClips()),
      ]),
      publish,
    ]);
  }

  // What a Project is configured with takes the stage in place of the clips,
  // because it is read and changed a few times in a Project's life while the
  // clips are what the app is open for the rest of the time.
  if (app.stage.kind !== "action") {
    return el("section", { class: "stage" }, [
      ...trouble,
      configuringHead(app, handlers, where),
      configuration,
    ]);
  }

  if (app.projects.length === 0) {
    return el("section", { class: "stage" }, [
      ...trouble,
      el("div", { class: "empty" }, [
        "No Projects are configured in this workspace. One is a directory under ",
        el("code", {}, ["projects/"]),
        " holding a ",
        el("code", {}, ["project.toml"]),
        ", which this will write.",
        el("div", { class: "row" }, [
          button("Configure a Project", "act primary", () => handlers.showNewProject()),
        ]),
      ]),
    ]);
  }

  const project = chosenProject(app);
  const action = chosenAction(app);

  if (project === undefined || action === undefined) {
    return el("section", { class: "stage" }, [
      ...trouble,
      el("div", { class: "empty" }, ["This Project declares no Actions yet."]),
    ]);
  }

  const preview = previewing(app);

  return el("section", { class: "stage" }, [
    ...trouble,
    el("div", { class: "stage-head" }, [
      el("h2", {}, [action.action]),
      el("span", { class: "muted" }, [project.configured.name]),
      el("span", { class: "spacer" }),
      // A Preview is the tuning loop and a Run is the clip, so the button that
      // opens one sits beside the buttons that record.
      button(
        preview === undefined ? "Preview" : "Back to the clips",
        `act${preview === undefined ? "" : " selected"}`,
        () => handlers.showPreview(preview === undefined),
      ),
      button("Run Project", "act", () => handlers.runProject(project.configured.name)),
      ...(runAction === null ? [] : [runAction]),
    ]),
    el("p", { class: "stage-meta" }, [recordedOf(project, action)]),
    standing,
    progress,
    ...(action.failure === null ? [] : [troublePanel("The Run failed", action.failure)]),
    // The clips and the Preview are both the thing being looked at, and a stage
    // holding two videos and a live site at once is a stage nobody can read. So
    // a Preview takes the stage in place of them, and gives it back.
    preview === undefined
      ? el("div", { class: "stage-body" }, [comparison(action), beside(action)])
      : el("div", { class: "stage-body previewing" }, [
          written.previewAbove,
          ...(preview.origin === null || preview.timeline === null
            ? []
            : [playerFor(preview.origin, preview.timeline, frameShowing)]),
          written.previewBelow,
        ]),
  ]);
}

/**
 * What is said above the Preview: what it is, and -- more to the point -- what
 * it deliberately is not.
 *
 * Said on its face rather than in a document somebody has to have read, because
 * judging a surround, a cursor or a colour scheme by something that never
 * showed one is exactly the mistake this is here to prevent.
 */
function previewHead(preview: Preview, handlers: Handlers): readonly Node[] {
  const said = showing();

  return [
    el("div", { class: "preview-head" }, [
      el("h3", {}, ["Preview"]),
      el("span", { class: "muted" }, ["played live against the running Project"]),
      el("span", { class: "spacer" }),
      ...(preview.timeline === null
        ? []
        : [
            button(said?.playing === true ? "Pause" : "Play", "act", () =>
              handlers.playPreview(said?.playing !== true),
            ),
          ]),
    ]),
    el("p", { class: "preview-not" }, [
      "This is not the clip. It shows no Mockup, no drawn cursor, no keystroke captions, no " +
        "replacement copy and no Condition, and it produces nothing — no Frames, no Artifacts " +
        "and no history. It plays at this browser's refresh rate, so framerate is the one " +
        "Parameter a Preview cannot answer: record it to judge smoothness.",
    ]),
    ...(preview.trouble === null ? [] : [troublePanel("There is no Preview", preview.trouble)]),
    ...(preview.trouble === null && preview.timeline === null
      ? [el("p", { class: "faint" }, ["asking what this Action's Timeline comes to…"])]
      : []),
  ];
}

/**
 * ...and what is said below it: where in the Timeline it has reached, the way
 * to any other moment of it, and what a Run of it would cost.
 */
function previewFoot(
  preview: Preview,
  handlers: Handlers,
  frame: HTMLElement,
): readonly Node[] {
  const timeline = preview.timeline;

  if (timeline === null) {
    return [];
  }

  const said = showing();

  const scrub = el("input", {
    type: "range",
    class: "scrub",
    "aria-label": "Which Frame of the Timeline is showing",
    min: "0",
    max: String(Math.max(0, timeline.frames - 1)),
    step: "1",
    value: String(said?.at ?? 0),
  });

  // Scrubbing holds the Preview where it was put: looking hard at the moment a
  // travel settles is the other half of what watching it loop is for.
  scrub.addEventListener("input", () => handlers.scrub(Number(scrub.value)));
  scrubbing = scrub;

  return [
    el("div", { class: "preview-scrub" }, [scrub]),
    el("p", { class: "preview-cost" }, [
      frame,
      el("span", { class: "spacer" }),
      el("span", { class: "faint num" }, [costOf(timeline)]),
    ]),
  ];
}

/**
 * What a Run of this Timeline would cost, so that asking for one is a decision
 * rather than a surprise -- and the viewport it is being judged at, since a
 * distance only means the same thing in the clip if the page is the same width.
 */
function costOf(timeline: NonNullable<Preview["timeline"]>): string {
  const { width, height } = timeline.preview.viewport;

  return (
    `${many(timeline.frames, "Frame")} at ${timeline.framerate}fps · ` +
    `${(timeline.durationMs / 1000).toFixed(2)}s · ${width}×${height}`
  );
}

/**
 * Where the Project answers, and that this Action has never been recorded where
 * it has not. What each Run was recorded under is said beside that Run rather
 * than here, now that there are two of them on the stage.
 */
function recordedOf(project: ProjectState, action: ActionState): string {
  return [
    project.configured.baseUrl,
    ...(latestOf(action) === null ? ["never recorded"] : []),
  ].join(" · ");
}

/**
 * What the stage says about how the Action on it stands: that its Project has
 * been committed to since the Latest was recorded, and whatever staleness the
 * command could not tell either way.
 *
 * Both are the command's answer. Nothing here compares two commits: what counts
 * as Stale is `record status`, and a second opinion in a page would be a second
 * place for that rule to drift.
 */
function standingOf(app: App): readonly Node[] {
  const action = chosenAction(app);
  const project = chosenProject(app);
  const latest = action === undefined ? null : latestOf(action);

  const since =
    latest?.commit == null || project?.commit == null
      ? ""
      : ` — ${shortCommit(latest.commit)} then, ${shortCommit(project.commit)} now`;

  return [
    ...(action?.stale === true
      ? [
          el("p", { class: "gone-stale" }, [
            `The Project has been committed to since this Action last ran${since}.`,
          ]),
        ]
      : []),
    // Said in the command's own words: "not Stale" and "cannot be told" are
    // different answers, and only one of them means the clip still stands.
    ...app.cannotTell.map((said) => el("p", { class: "faint" }, [said])),
    // ...and an answer that never arrived is a third: the flags say what the
    // last one said, which is not what this machine says now.
    ...(app.unread === null ? [] : [troublePanel("Staleness could not be read", app.unread)]),
  ];
}

/**
 * The Latest and the Run before it, side by side.
 *
 * One clip says what the site does now; two say what changed, which is the half
 * of re-recording that makes it worth pressing. An Action with nothing to
 * compare says so plainly rather than standing an empty player next to the
 * clip it has.
 *
 * The Latest is the one drawn against the other, so a difference reads as
 * something this Run has and the one before it did not. Marked on both, it would
 * say only that the two are not the same, which is what having two of them on
 * the stage already says.
 */
function comparison(action: ActionState): HTMLElement {
  const latest = latestOf(action);
  const previous = previousOf(action);

  if (latest === null) {
    return el("div", { class: "empty" }, [
      "Nothing has been recorded for this Action yet. Run it, and the clip plays here.",
    ]);
  }

  return el("div", { class: "compare" }, [
    runPanel("Latest", latest, previous),
    previous === null
      ? el("div", { class: "run" }, [
          runHead("Previous", null),
          el("div", { class: "empty" }, [
            "This is the only Run of this Action kept on this machine. Run it again and the one " +
              "before it plays here, to judge the change against.",
          ]),
        ])
      : runPanel("Previous", previous, null),
  ]);
}

/**
 * One Run on the stage: its clip, and what it was recorded under. A clip nobody
 * can place is a clip nobody can judge, so the commit it was recorded against
 * and the Parameters it ran with are beside it rather than in a file somewhere.
 */
function runPanel(which: Which, run: Run, against: Run | null): HTMLElement {
  return el("div", { class: "run" }, [
    runHead(which, run),
    clip(run),
    facts(run, against),
    recordedWith(run, against),
  ]);
}

/** Which of the two a clip is, and when it was recorded. */
function runHead(which: Which, run: Run | null): HTMLElement {
  return el("div", { class: "run-head" }, [
    el("h3", {}, [which]),
    el("span", { class: "spacer" }),
    ...(run === null ? [] : [el("span", { class: "faint" }, [ago(run.recordedAt)])]),
  ]);
}

/**
 * What a Run was recorded against: the Project's commit, and how much was
 * captured. A commit that differs from the Run being judged against is marked,
 * because a Project committed to between the two is the reason to be looking at
 * both of them.
 */
function facts(run: Run, against: Run | null): HTMLElement {
  const differs = against !== null && run.commit !== against.commit;

  return el("p", { class: "facts" }, [
    el("span", { ...(differs ? { class: "changed" } : {}) }, [
      run.commit === null ? "no commit to read" : `commit ${shortCommit(run.commit)}`,
    ]),
    el("span", { class: "spacer" }),
    el("span", { class: "faint num" }, [`${run.frames.captured} Frames at ${run.framerate}fps`]),
  ]);
}

/**
 * What the Action ran with when this Run recorded, declarations and Overrides
 * together, as the Run's own record says. An Override is marked as one, and so
 * is a value that differs from the Run this one is judged against: a clip that
 * changed because a slider moved and one that changed because the site did are
 * not the same news.
 */
function recordedWith(run: Run, against: Run | null): HTMLElement {
  const values = Object.entries(run.parameters);

  return el("div", { class: "recorded-with" }, [
    el("h4", {}, ["Recorded with"]),
    ...(values.length === 0
      ? [el("p", { class: "faint" }, ["this Run recorded no Parameters"])]
      : [
          el(
            "ul",
            {},
            values.map(([name, value]) => recordedValue(run, against, name, value)),
          ),
        ]),
  ]);
}

function recordedValue(
  run: Run,
  against: Run | null,
  name: string,
  value: ParameterSetting,
): HTMLElement {
  // Compared as they read rather than by type: a Parameter the other Run never
  // carried differs from this one, which is what an Action rewritten between the
  // two of them looks like.
  const differs = against !== null && String(against.parameters[name]) !== String(value);
  const marks = [
    ...(run.overridden.includes(name) ? ["overridden"] : []),
    ...(differs ? ["changed"] : []),
  ];

  return el("li", { ...(marks.length === 0 ? {} : { class: marks.join(" ") }) }, [
    el("span", { class: "name" }, [name]),
    el("span", { class: "spacer" }),
    el("span", { class: "num" }, [String(value)]),
  ]);
}

/** As much of a commit as places a Run, which is as much as anyone reads of one. */
function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * One Run playing where it will be embedded. WebM first and the MP4 behind it,
 * exactly as the embed snippet names them (ADR 0006).
 *
 * A failed Run took its own directory away with it, so what plays here is a Run
 * that succeeded whether or not the most recent request for it did.
 */
function clip(run: Run): HTMLElement {
  const webm = artifactOf(run, "webm");
  const mp4 = artifactOf(run, "mp4");

  if (webm === undefined || mp4 === undefined) {
    return el("div", { class: "empty" }, [
      "This Run left no video Artifact to play, which is what its own record says.",
    ]);
  }

  const video = el("video", { preload: "metadata" }, [
    el("source", { src: artifactUrl(run, webm), type: "video/webm" }),
    el("source", { src: artifactUrl(run, mp4), type: "video/mp4" }),
  ]);

  video.controls = true;
  video.autoplay = true;
  video.loop = true;
  // No browser autoplays a clip that could make a noise, and no Run records one.
  video.muted = true;
  video.playsInline = true;
  video.width = webm.width;
  video.height = webm.height;

  return el("div", { class: "clip" }, [video]);
}

/**
 * The width to the right of the clips, which the layout leaves over: what the
 * Latest produced, and where each of its files is. The Latest's rather than the
 * previous Run's, because the Latest is what is embedded and Published.
 */
function beside(action: ActionState): HTMLElement {
  const latest = latestOf(action);

  if (latest === null) {
    return el("aside", { class: "beside" }, [
      el("h3", {}, ["Artifacts of the Latest"]),
      el("p", { class: "faint" }, ["A Run produces an MP4, a WebM and a GIF."]),
    ]);
  }

  return el("aside", { class: "beside" }, [
    el("h3", {}, ["Artifacts of the Latest"]),
    el("ul", {}, [
      ...latest.artifacts.map((artifact) =>
        el("li", {}, [
          link(artifactUrl(latest, artifact), artifact.format),
          el("span", { class: "spacer" }),
          el("span", { class: "faint num" }, [
            `${artifact.width}×${artifact.height} · ${artifact.framerate}fps`,
          ]),
        ]),
      ),
      el("li", {}, [
        link(embedUrl(latest), "embed snippet"),
        el("span", { class: "spacer" }),
        el("span", { class: "faint num" }, [`${(secondsOf(latest) ?? 0).toFixed(1)}s`]),
      ]),
    ]),
  ]);
}

/** How long the clip runs, as the video Artifacts were encoded. */
function secondsOf(run: Run): number | undefined {
  const video = artifactOf(run, "webm") ?? artifactOf(run, "mp4");

  return video === undefined ? undefined : video.durationMs / 1000;
}

function artifactOf(run: Run, format: Artifact["format"]): Artifact | undefined {
  return run.artifacts.find((artifact) => artifact.format === format);
}

/**
 * Everything tunable about the Action on the stage: a control per declared
 * Parameter, marked where it has been overridden, and the Overrides the Action
 * will not take said out loud.
 */
function tuningIn(app: App, handlers: Handlers): readonly Node[] {
  // The Parameters are the Action on the stage's, and while a Project is being
  // configured there is no Action on it.
  const action = playing(app);

  if (action === undefined) {
    return [];
  }

  const heading = el("h3", {}, ["Parameters"]);
  const tuning = action.tuning;

  if (tuning === null) {
    return [heading, el("p", { class: "faint" }, ["reading what this Action declares…"])];
  }

  return [
    heading,
    // A Parameter the Action no longer declares, or a value it will not take:
    // said here rather than left in a sidecar nobody opens, because the Action
    // is running with its declared default and reads as though it were tuned.
    ...(tuning.warnings.length === 0
      ? []
      : [
          troublePanel(
            "Overrides that were not applied",
            [...tuning.warnings, `They are written in ${tuning.sidecar}`].join("\n"),
          ),
        ]),
    ...(action.refused === null ? [] : [troublePanel("That value was refused", action.refused)]),
    ...tuning.parameters.map((parameter) => control(action, parameter, handlers)),
  ];
}

/**
 * One Parameter as the control its declaration calls for: a slider and a box for
 * a number within its range, a menu for one of a named set, a box to tick for a
 * flag. An Override is marked as one and can be put back, so that trying a value
 * is never one-way.
 */
function control(action: ActionState, parameter: Parameter, handlers: Handlers): HTMLElement {
  const tune = (value: ParameterSetting): void =>
    handlers.tune(action.project, action.action, parameter.name, value);
  // What a value still being dragged does: the Preview is re-evaluated as if it
  // applied, and the sidecar is left alone until it is let go of.
  const tried = (value: ParameterSetting): void =>
    handlers.tryValue(action.project, action.action, parameter.name, value);

  const value = el("span", { class: `value num ${parameter.overridden ? "" : "faint"}` }, [
    String(parameter.value),
  ]);

  return el("div", { class: `param${parameter.overridden ? " overridden" : ""}` }, [
    el("div", { class: "row" }, [
      nameOf(parameter),
      value,
      ...(parameter.overridden
        ? [
            button("reset", "act tiny", () =>
              handlers.reset(action.project, action.action, parameter.name),
            ),
          ]
        : []),
    ]),
    el("div", { class: "describes" }, [
      parameter.overridden
        ? `${parameter.describes} · declared ${String(parameter.default)}`
        : parameter.describes,
    ]),
    ...(parameter.kind === "number"
      ? numberControl(parameter, extentOf(parameter), value, tune, tried)
      : parameter.kind === "flag"
        ? [tickBox(fieldOf(parameter), labelOf(parameter), parameter.value === true, tune)]
        : [menu(fieldOf(parameter), parameter.choices ?? [], parameter.value, tune)]),
  ]);
}

/**
 * What the Parameter is called, which is what its control is labelled by.
 *
 * Everything but a flag is labelled with a `<label>`, so that reading the name
 * and reaching the control are one gesture. A flag is not: clicking the label of
 * a box to tick ticks it, and ticking it writes an Override to disk -- reading
 * the name of a Parameter must not tune it.
 */
function nameOf(parameter: Parameter): HTMLElement {
  return parameter.kind === "flag"
    ? el("span", { class: "name", id: labelOf(parameter) }, [parameter.name])
    : el("label", { class: "name", id: labelOf(parameter), for: fieldOf(parameter) }, [
        parameter.name,
      ]);
}

/**
 * The range a number is tuned within, as its declaration reported it -- and
 * nothing at all where the report carried none.
 *
 * A declared number always names its range, so nothing here should ever be
 * missing. Standing in a 0 for one that is would draw a slider that runs from
 * nowhere to nowhere, which is a control that lies rather than one that is
 * absent, so the number is offered as a box on its own instead.
 */
function extentOf(parameter: Parameter): { readonly min: number; readonly max: number } | undefined {
  return parameter.min === undefined || parameter.max === undefined
    ? undefined
    : { min: parameter.min, max: parameter.max };
}

/**
 * A number, as a slider and as a box: the slider is how a duration is felt out,
 * and the box is how a value already known is typed rather than hunted for.
 *
 * The slider writes when it is let go of and not while it is moving, because
 * every write is an Override written to disk -- but the readout follows it, and
 * so does the Preview, so what is being chosen is visible before it is chosen.
 */
function numberControl(
  parameter: Parameter,
  extent: { readonly min: number; readonly max: number } | undefined,
  readout: HTMLElement,
  tune: (value: ParameterSetting) => void,
  tried: (value: ParameterSetting) => void,
): readonly Node[] {
  const within = extent === undefined ? {} : { min: String(extent.min), max: String(extent.max) };
  const step = extent === undefined ? {} : { step: String(stepOf(extent)) };

  const box = el("input", {
    type: "number",
    class: "typed num",
    ...within,
    ...step,
    value: String(parameter.value),
    ...(extent === undefined ? { id: fieldOf(parameter) } : {}),
  });

  // A box cleared or filled with something that is not a number is not a value
  // to write: `Number("")` is 0, which would either be recorded as an Override
  // nobody typed or refused as a value nobody chose. What is really in the
  // sidecar goes back in the box instead.
  box.addEventListener("change", () => {
    const typed = Number(box.value);

    if (box.value.trim() === "" || !Number.isFinite(typed)) {
      box.value = String(parameter.value);
      return;
    }

    tune(typed);
  });

  if (extent === undefined) {
    return [el("div", { class: "sliding" }, [box])];
  }

  const range = el("input", {
    id: fieldOf(parameter),
    type: "range",
    ...within,
    ...step,
    value: String(parameter.value),
  });

  range.addEventListener("input", () => {
    readout.textContent = range.value;
    box.value = range.value;
    // The change and the motion are the same event: a Preview keeps playing
    // while this moves, re-evaluated under a value written nowhere.
    tried(Number(range.value));
  });
  range.addEventListener("change", () => tune(Number(range.value)));

  return [
    el("div", { class: "sliding" }, [range, box]),
    // What the declaration will take, since a slider does not say where it ends.
    el("div", { class: "extent faint num" }, [
      String(extent.min),
      el("span", {}, ["–"]),
      String(extent.max),
    ]),
  ];
}

/**
 * How finely a slider moves, and what the box beside it will take.
 *
 * Whole units wherever the range is wide enough to want them, which is every
 * duration, distance and framerate an Action declares. A narrower range is
 * tuned in tenths and then in hundredths -- and never in a step derived from the
 * span itself, which for 1..4 would be 0.03: a slider that cannot reach 2, and a
 * box that calls 2 invalid for a Parameter counted in whole units.
 */
function stepOf(extent: { readonly min: number; readonly max: number }): number {
  const span = extent.max - extent.min;

  if (span >= 20) {
    return 1;
  }
  if (span >= 2) {
    return 0.1;
  }

  // A range of nothing is one value, and a step of 0 is a control no browser
  // will move.
  return span <= 0 ? 1 : 0.01;
}

/**
 * One of a named set: an easing, a choice, a Mockup. Built from what it is
 * called and what it takes rather than from a Parameter or a setting, because
 * picking one of a list is the same gesture whichever of the two it writes.
 */
function menu(
  field: string,
  choices: readonly string[],
  chosen: ParameterSetting | null,
  chose: (value: string) => void,
): HTMLElement {
  const select = el("select", { id: field });

  for (const choice of choices) {
    const option = el("option", { value: choice }, [choice]);
    option.selected = choice === chosen;
    select.append(option);
  }

  select.addEventListener("change", () => chose(select.value));

  return select;
}

/**
 * A box to tick, labelled by the name of what it is worth rather than by the
 * value beside it: "cursorCaptions", not "false".
 */
function tickBox(
  field: string,
  labelledBy: string,
  ticked: boolean,
  tick: (on: boolean) => void,
): HTMLElement {
  const box = el("input", {
    id: field,
    type: "checkbox",
    "aria-labelledby": labelledBy,
  });

  box.checked = ticked;
  box.addEventListener("change", () => tick(box.checked));

  return el("label", { class: "ticking" }, [box, String(ticked)]);
}

/**
 * What the stage says it is showing while a Project is being configured: which
 * Project, where that is written down, and the way back to the clips.
 */
function configuringHead(app: App, handlers: Handlers, where: HTMLElement): HTMLElement {
  // Named from what was asked for rather than from what was found, so a Project
  // that has gone from the workspace is still said by name.
  const named = app.stage.kind === "configuration" ? app.stage.project : "A new Project";

  return el("div", { class: "stage-head" }, [
    el("h2", {}, [named]),
    // Where it is written is not known until it has been read, so it is written
    // into rather than drawn: the file arrives with the settings do.
    where,
    el("span", { class: "spacer" }),
    button("Back to the clips", "act", () => handlers.showClips()),
  ]);
}

/** Where the Project on the stage is configured, as far as that is known yet. */
function whereOf(app: App): string {
  if (app.stage.kind === "new") {
    return "configured here, and recorded from here after that";
  }

  return configuring(app)?.configuration?.file ?? "reading its configuration…";
}

/**
 * Everything one Project is configured with: a control per setting, marked
 * where the file says it rather than the tool standing a value in, and whatever
 * the tool refused said in its own words.
 *
 * Which settings there are is the command's answer. Nothing here keeps a list
 * of them, so a Project that grows a setting grows a control without the app
 * being told twice.
 */
function configurationIn(
  app: App,
  handlers: Handlers,
  notConfigured: HTMLElement,
): readonly Node[] {
  if (app.stage.kind === "new") {
    notConfigured.replaceChildren(...notConfiguredIn(app));

    return [newProject(handlers, notConfigured)];
  }

  const project = configuring(app);

  if (project === undefined) {
    return [];
  }

  const configuration = project.configuration;

  if (configuration === null) {
    return [el("p", { class: "faint" }, ["reading what this Project is configured with…"])];
  }

  const name = project.configured.name;

  return [
    ...(project.misconfigured === null
      ? []
      : [troublePanel("That setting was refused", project.misconfigured)]),
    ...configuration.settings.map((setting) => settingControl(name, setting, handlers)),
    el("p", { class: "faint" }, [
      "Actions are written beside this file, under actions/, and stay the agent's.",
    ]),
  ];
}

/**
 * One setting as the control its kind calls for: a box for text, a number box
 * within its range, a menu for one of a named set, a box to tick for a flag.
 *
 * A setting the file does not say is marked as standing rather than written,
 * and one it does say can be cleared -- which takes the line out and leaves the
 * tool's own value standing again. What a Project cannot record without has no
 * such button: emptying it is refused, and offering it would be offering a
 * refusal.
 */
function settingControl(project: string, setting: Setting, handlers: Handlers): HTMLElement {
  const configure = (value: string): void => handlers.configure(project, setting.name, value);
  const clearable = setting.written && !setting.required;

  return el("div", { class: `setting${setting.written ? " written" : ""}` }, [
    el("div", { class: "row" }, [
      nameOfSetting(setting),
      el("span", { class: "spacer" }),
      ...(setting.written ? [] : [el("span", { class: "faint tag" }, ["standing"])]),
      ...(clearable ? [button("clear", "act tiny", () => configure(""))] : []),
    ]),
    el("div", { class: "describes" }, [setting.describes]),
    setting.kind === "flag"
      ? tickBox(settingField(setting), settingLabel(setting), setting.value === true, (on) =>
          configure(String(on)),
        )
      : setting.kind === "choice"
        ? menu(settingField(setting), setting.choices ?? [], setting.value, configure)
        : box(setting, configure),
  ]);
}

/**
 * What the setting is called, which is the name it is written under in the
 * file -- so that what the app shows and what the file says are one word.
 *
 * A flag is labelled by a name that does not reach for its box: clicking the
 * label of a box to tick ticks it, and ticking it writes to the file.
 */
function nameOfSetting(setting: Setting): HTMLElement {
  return setting.kind === "flag"
    ? el("span", { class: "name num", id: settingLabel(setting) }, [setting.name])
    : el("label", { class: "name num", id: settingLabel(setting), for: settingField(setting) }, [
        setting.name,
      ]);
}

/** A setting typed rather than picked, which is text and a number alike. */
function box(setting: Setting, configure: (value: string) => void): HTMLElement {
  const written = setting.value === null ? "" : String(setting.value);

  const field = el("input", {
    id: settingField(setting),
    class: `typed${setting.kind === "number" ? " num" : ""}`,
    type: setting.kind === "number" ? "number" : "text",
    value: written,
    ...(setting.min === undefined ? {} : { min: String(setting.min) }),
    ...(setting.max === undefined ? {} : { max: String(setting.max) }),
    ...(setting.required ? { required: "required" } : {}),
  });

  // Written when the box is left rather than as it is typed in: every change is
  // a line rewritten in a file, and a URL is not a value halfway through
  // spelling it.
  field.addEventListener("change", () => {
    if (field.value === written) {
      return;
    }
    configure(field.value);
  });

  return el("div", { class: "typing" }, [field]);
}

/**
 * The form a Project this machine does not have yet is configured from: a name
 * for the directory it will be configured in, and the two settings it cannot be
 * configured without.
 *
 * Everything else is left to the settings this opens onto once it exists, and
 * what may be written at all is the command's answer -- a request it refuses
 * comes back in its own words rather than being guessed at here.
 *
 * This is the one place outside the command's own registry that spells a
 * setting's name, because there is no Project yet to have asked what its
 * settings are. If what a Project cannot be configured without ever changes,
 * `record add` says so in words that name it.
 */
function newProject(handlers: Handlers, notConfigured: HTMLElement): HTMLElement {
  const name = field("name", "the directory it is configured in");
  const baseUrl = field("base_url", "http://127.0.0.1:5173/");
  const repository = field("source_repository", "where the Project's own code is");

  const add = (): void =>
    handlers.add(name.value.trim(), [
      `base_url=${baseUrl.value.trim()}`,
      `source_repository=${repository.value.trim()}`,
    ]);

  return el("div", { class: "new-project" }, [
    el("p", { class: "faint" }, [
      "A Project is a website running on this machine. It is never Published until it is " +
        "turned on, one Project at a time.",
    ]),
    labelled("name", name),
    labelled("base_url", baseUrl),
    labelled("source_repository", repository),
    notConfigured,
    el("div", { class: "row" }, [button("Configure it", "act primary", add)]),
  ]);
}

/** Why the Project the app was last asked to add was not configured, if it was not. */
function notConfiguredIn(app: App): readonly Node[] {
  return app.notConfigured === null
    ? []
    : [troublePanel("That Project was not configured", app.notConfigured)];
}

/** One box of the form, which is only ever read when the form is submitted. */
function field(name: string, placeholder: string): HTMLInputElement {
  return el("input", {
    id: `new-${name}`,
    class: "typed",
    type: "text",
    placeholder,
  });
}

function labelled(name: string, box: HTMLInputElement): HTMLElement {
  return el("div", { class: "setting" }, [
    el("label", { class: "name num", for: `new-${name}` }, [name]),
    el("div", { class: "typing" }, [box]),
  ]);
}

/**
 * Exactly what publishing would make public: every file, how big it is, and
 * which Project and Action it is the Latest of.
 *
 * The confirmation is a button under a list somebody has read, rather than a
 * box to tick or a second click on the same button. This is the only
 * irreversible, outward-facing thing the tool does and the only route by which
 * something private could become public (ADR 0007), so what is about to happen
 * is spelled out first and nothing happens until it has been agreed to.
 */
function publishIn(app: App, handlers: Handlers): readonly Node[] {
  if (app.stage.kind !== "publish") {
    return [];
  }

  // In the command's own words: "not a git repository" and "the clips were
  // committed and the push failed" are different problems with different next
  // steps, and only the command knows which of them happened.
  const trouble =
    app.notPublished === null ? [] : [troublePanel("Publishing did not happen", app.notPublished)];

  const report = app.publish;

  if (report === null) {
    return [
      ...trouble,
      ...(app.publishing
        ? [el("p", { class: "faint" }, ["reading what publishing would make public…"])]
        : [el("div", { class: "row" }, [readAgain(handlers)])]),
    ];
  }

  const { plan } = report;
  const nothing = plan.files.length === 0 && plan.removing.length === 0;

  return [
    ...trouble,
    ...(report.published ? [el("div", { class: "published-as" }, [outcomeOf(report)])] : []),
    el("p", { class: "faint" }, [
      `Everything below is copied into ${plan.directory}/ in this repository, committed and ` +
        "pushed. No Project's own repository is written to at all.",
    ]),
    // A Project that is Published and has nothing to publish, or an Artifact
    // its Run's record names and this machine no longer has: said here, because
    // a plan of fewer files than expected is otherwise a plan nobody questions.
    ...(plan.warnings.length === 0
      ? []
      : [troublePanel("What the plan could not account for", plan.warnings.join("\n"))]),
    ...(nothing
      ? [
          el("div", { class: "empty" }, [
            "No Published Project has a clip to make public. Publishing is turned on one " +
              "Project at a time, in its settings.",
          ]),
        ]
      : plan.projects.flatMap(publishedProject)),
    // What would stop being public, which is the other half of what a plan has
    // to say: a Project no longer Published is a clip that has to come down.
    ...(plan.removing.length === 0
      ? []
      : [
          el("div", { class: "publish-removing" }, [
            el("h3", {}, ["Taken back out"]),
            el(
              "ul",
              {},
              plan.removing.map((path) => el("li", {}, [el("span", { class: "path" }, [path])])),
            ),
          ]),
        ]),
    el("p", { class: "publish-total" }, [totalOf(plan)]),
    el("div", { class: "row" }, [
      ...(report.published
        ? [readAgain(handlers)]
        : nothing
          ? []
          : [confirming(app, plan, handlers)]),
    ]),
  ];
}

/**
 * What became of the plan, said as what a person would want to be told -- the
 * branch included, since this repository is pushed as it stands and a publish
 * from a branch nobody reads is not a clip anybody can link to.
 */
function outcomeOf(report: PublishReport): string {
  const on = `${shortCommit(report.commit ?? "")} on ${report.branch ?? "this branch"}`;

  if (report.commit === null) {
    return "Everything Published was already public, so nothing was committed.";
  }
  if (!report.pushed) {
    return `Committed as ${on}, and this repository was not pushed.`;
  }

  return `Published as ${on}, and pushed. These clips are public now.`;
}

/**
 * What the plan comes to: how much would be public, and how much would stop
 * being. A plan that only takes clips down is still a plan worth reading, so it
 * is counted rather than reading as nothing happening.
 */
function totalOf(plan: PublishPlan): string {
  const counted = [
    ...(plan.files.length === 0
      ? []
      : [`${many(plan.files.length, "file")} · ${asBytes(plan.bytes)} into ${plan.directory}/`]),
    ...(plan.removing.length === 0
      ? []
      : [`${many(plan.removing.length, "file")} taken back out`]),
  ];

  return counted.length === 0 ? `nothing to put into ${plan.directory}/` : counted.join(" · ");
}

/**
 * The button that makes it happen, named for what it will do rather than for
 * itself: "Publish" is what was pressed to get here, and pressing the same word
 * twice is how something goes public without being read.
 */
function confirming(app: App, plan: PublishPlan, handlers: Handlers): HTMLButtonElement {
  const pressing = button(
    app.publishing ? "publishing…" : askingFor(plan),
    "act primary",
    () => handlers.publish(),
  );

  pressing.disabled = app.publishing;

  return pressing;
}

/** What pressing it would do, in the words of what it would do. */
function askingFor(plan: PublishPlan): string {
  if (plan.files.length === 0) {
    return `Take ${many(plan.removing.length, "file")} back out of GitHub`;
  }
  if (plan.removing.length === 0) {
    return `Publish ${many(plan.files.length, "file")} to GitHub`;
  }

  return (
    `Publish ${many(plan.files.length, "file")} and take ` +
    `${many(plan.removing.length, "file")} back out`
  );
}

/**
 * Reading the plan again rather than keeping the one already read: a machine
 * that has recorded since is a machine with something else to publish.
 */
function readAgain(handlers: Handlers): HTMLButtonElement {
  return button("Read the plan again", "act", () => handlers.showPublish());
}

/** One Project's contribution: its Actions, each with the files of its Latest. */
function publishedProject(project: PublishedProject): readonly Node[] {
  return [
    el("h3", { class: "publish-project" }, [project.project]),
    ...(project.actions.length === 0
      ? [el("p", { class: "faint" }, ["nothing recorded yet, so this Project makes nothing public"])]
      : project.actions.map(publishedAction)),
  ];
}

/**
 * One Action's Latest, and each file it would land as. A Condition is named
 * beside the Action, because the clip of the dark theme and the clip of the
 * light one are two clips and a README naming one must not be handed the other.
 */
function publishedAction(action: PublishedAction): HTMLElement {
  return el("div", { class: "published-action" }, [
    el("div", { class: "row" }, [
      el("span", { class: "name" }, [action.action]),
      ...(action.condition === null ? [] : [el("span", { class: "pill" }, [action.condition])]),
      el("span", { class: "spacer" }),
      el("span", { class: "faint" }, [ago(action.recordedAt)]),
    ]),
    el(
      "ul",
      {},
      action.files.map((file) =>
        el("li", {}, [
          el("span", { class: "path" }, [file.path]),
          el("span", { class: "spacer" }),
          el("span", { class: "faint num" }, [asBytes(file.bytes)]),
        ]),
      ),
    ),
  ]);
}

/** How big a file is, as somebody deciding whether to make it public reads it. */
function asBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** What a setting's control is called, so its label is the label of that control. */
function settingField(setting: Setting): string {
  return `setting-${setting.name}`;
}

/** ...and what its name is called, for a control labelled by it rather than for it. */
function settingLabel(setting: Setting): string {
  return `setting-${setting.name}-name`;
}

/** What a control is called, so its label is the label of that control. */
function fieldOf(parameter: Parameter): string {
  return `parameter-${parameter.name}`;
}

/** ...and what that name is called, for a control labelled by it rather than for it. */
function labelOf(parameter: Parameter): string {
  return `parameter-${parameter.name}-name`;
}


/**
 * What each stage of a Run reads as: on the stage, and as short as a rail is
 * wide. One table rather than two cascades, because a stage that read as one
 * thing in the rail and another on the stage would be two Runs to the operator.
 */
const stages: Record<Doing["stage"], { readonly said: string; readonly short: string }> = {
  queued: { said: "queued for the machine", short: "queued" },
  starting: { said: "starting the Project", short: "starting" },
  capturing: { said: "capturing Frames", short: "capturing" },
  encoding: { said: "encoding the Artifacts", short: "encoding" },
};

/** What a Run in flight is doing, said as a line and drawn as a bar. */
function inFlight(doing: Doing): readonly Node[] {
  const frames = doing.frames;
  const through = frames === null || frames.of === 0 ? null : frames.captured / frames.of;

  return [
    el("div", { class: "line" }, [
      el("span", {}, [stages[doing.stage].said]),
      el("span", { class: "spacer" }),
      ...(frames === null
        ? []
        : [el("span", { class: "faint num" }, [`Frame ${frames.captured} of ${frames.of}`])]),
    ]),
    el("div", { class: "bar" }, [
      el("span", { style: `width: ${Math.round((through ?? 0) * 100)}%` }),
    ]),
  ];
}

/**
 * How an Action reads in the rail: how far through its Run is where that is
 * known, and that its last Run failed where one did.
 *
 * A failure is said here as well as on the stage because a request can name
 * every Action there is: a Run that failed on an Action nobody is looking at
 * would otherwise have to be guessed at, one Action at a time.
 */
function badgeOf(action: ActionState): { readonly text: string; readonly failed: boolean } {
  const doing = action.doing;

  if (doing === null) {
    return { text: action.failure === null ? "" : "failed", failed: action.failure !== null };
  }
  if (doing.stage === "capturing" && doing.frames !== null && doing.frames.of > 0) {
    return {
      text: `${Math.round((doing.frames.captured / doing.frames.of) * 100)}%`,
      failed: false,
    };
  }

  return { text: stages[doing.stage].short, failed: false };
}

/** Why something failed, in the words it failed with. */
function troublePanel(about: string, message: string): HTMLElement {
  return el("div", { class: "trouble" }, [
    el("h3", {}, [about]),
    el("pre", {}, [message]),
  ]);
}

/** How long ago something happened, for a clip that is read as recent or not. */
function ago(instant: string): string {
  const since = Date.now() - new Date(instant).getTime();

  if (!Number.isFinite(since)) {
    return instant;
  }

  const minutes = Math.floor(since / 60_000);

  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${many(minutes, "minute")} ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${many(hours, "hour")} ago` : `${many(Math.floor(hours / 24), "day")} ago`;
}

/** A count and what it counts, said so that one of something reads as one. */
function many(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The Action a node belongs to, spelled so that two names cannot make one key. */
function keyOf(project: string, action: string): string {
  return JSON.stringify([project, action]);
}

function link(href: string, text: string): HTMLElement {
  return el("a", { href, target: "_blank", rel: "noreferrer" }, [text]);
}

function button(
  text: string,
  className: string,
  pressed: () => void,
  children: readonly Node[] = [],
): HTMLButtonElement {
  const element = el("button", { class: className, type: "button" }, [
    ...(text === "" ? [] : [text]),
    ...children,
  ]);

  element.addEventListener("click", pressed);

  return element;
}

/** One element, its attributes, and its children -- text as text, never as markup. */
function el<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  attributes: Readonly<Record<string, string>> = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);

  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }

  element.append(...children);

  return element;
}
