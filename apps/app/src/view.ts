/**
 * The page, drawn from the state.
 *
 * Everything is built as elements and given its text, never as markup: a Project
 * is named after a directory and an Action after a file, and a failure carries
 * whatever the command said. None of those are things a page should be able to
 * be written by.
 *
 * There are two ways in. `paint` draws the whole app, and is what a choice, a
 * request or a new Latest costs. `paintProgress` writes into the handful of nodes
 * a Run in flight changes -- because a Run says something every Frame, and
 * redrawing a stage sixty times a second would take the clip out from under
 * whoever is watching it.
 */
import {
  artifactUrl,
  embedUrl,
  type Artifact,
  type Parameter,
  type ParameterSetting,
  type Run,
} from "./api.js";
import {
  actionsIn,
  chosenAction,
  chosenProject,
  recording,
  type ActionState,
  type App,
  type Doing,
  type ProjectState,
} from "./model.js";

export type Handlers = {
  choose(project: string, action: string): void;
  runAction(project: string, action: string): void;
  runProject(project: string): void;
  runEverything(): void;
  showRailClips(showing: boolean): void;
  /** Overrides one Parameter of one Action, by the value it is to take. */
  tune(project: string, action: string, name: string, value: ParameterSetting): void;
  /** Removes that Override, leaving what the Action declares. */
  reset(project: string, action: string, name: string): void;
};

/** The nodes a Run in flight writes into, kept from the last full paint. */
type Live = {
  readonly tally: HTMLElement;
  /** One badge per Action, by the Action it belongs to. */
  readonly badges: Map<string, HTMLElement>;
  /** Where the Run of the Action on the stage says what it is doing. */
  readonly progress: HTMLElement;
  /** Disabled while the Action it records is already recording. */
  readonly runAction: HTMLButtonElement | null;
  /** The Parameters of the Action on the stage, which tuning redraws on its own. */
  readonly parameters: HTMLElement;
  /** What the controls in there call, since they are drawn again without a paint. */
  readonly handlers: Handlers;
};

let live: Live | undefined;

/** Draws the whole app. */
export function paint(root: HTMLElement, app: App, handlers: Handlers): void {
  const badges = new Map<string, HTMLElement>();
  const tally = el("span", { class: "faint" }, [tallyOf(app)]);
  const progress = el("div", { class: "progress" });
  const parameters = el("aside", { class: "params" });

  const chosen = chosenAction(app);
  const runAction =
    chosen === undefined
      ? null
      : button("Run Action", "act primary", () => handlers.runAction(chosen.project, chosen.action));

  root.replaceChildren(
    topbar(app, handlers, tally),
    el("div", { class: "body" }, [
      rail(app, handlers, badges),
      stage(app, handlers, progress, runAction),
      parameters,
    ]),
  );

  live = { tally, badges, progress, runAction, parameters, handlers };
  paintProgress(app);
  paintTuning(app);
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
 * Writes what every Run in flight is doing into the nodes already on the page.
 * Nothing here adds or removes anything, so a Frame arriving changes a word.
 */
export function paintProgress(app: App): void {
  if (live === undefined) {
    return;
  }

  live.tally.textContent = tallyOf(app);

  for (const action of actionsIn(app)) {
    const badge = live.badges.get(keyOf(action.project, action.action));

    if (badge !== undefined) {
      const says = badgeOf(action);

      badge.textContent = says.text;
      badge.className = says.failed ? "badge failed" : "badge num";
    }
  }

  const chosen = chosenAction(app);

  if (live.runAction !== null) {
    live.runAction.disabled = chosen?.doing != null;
  }

  live.progress.replaceChildren(...(chosen?.doing == null ? [] : inFlight(chosen.doing)));
}

function topbar(app: App, handlers: Handlers, tally: HTMLElement): HTMLElement {
  const railClips = button(
    app.railClips ? "Hide clips in rail" : "Show clips in rail",
    "act quiet",
    () => handlers.showRailClips(!app.railClips),
  );

  return el("header", { class: "topbar" }, [
    el("span", { class: "wordmark" }, ["record"]),
    tally,
    el("span", { class: "spacer" }),
    railClips,
    button("Run everything", "act primary", () => handlers.runEverything()),
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
function rail(app: App, handlers: Handlers, badges: Map<string, HTMLElement>): HTMLElement {
  return el(
    "nav",
    { class: "rail" },
    app.projects.flatMap((project) => [
      el("div", { class: "project" }, [
        el("span", {}, [project.configured.name]),
        ...(project.configured.published
          ? [el("span", { class: "pill published" }, ["published"])]
          : []),
      ]),
      ...(project.actions.length === 0
        ? [el("div", { class: "absent none" }, ["no Actions"])]
        : project.actions.map((action) => railAction(app, handlers, action, badges))),
    ]),
  );
}

function railAction(
  app: App,
  handlers: Handlers,
  action: ActionState,
  badges: Map<string, HTMLElement>,
): HTMLElement {
  const badge = el("span", { class: "badge num" });
  badges.set(keyOf(action.project, action.action), badge);

  const chosen =
    app.chosen?.project === action.project && app.chosen.action === action.action ? " selected" : "";

  const row = el("span", { class: "row" }, [el("span", { class: "name" }, [action.action]), badge]);

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
  const gif = action.latest === null ? undefined : artifactOf(action.latest, "gif");

  if (action.latest === null || gif === undefined) {
    return el("span", { class: "absent" }, ["not recorded yet"]);
  }

  // Fetched as the rail is drawn rather than as it is scrolled: these are files
  // on this machine, and a rail whose clips arrive only once something has
  // scrolled is a rail that reads as empty.
  const image = el("img", {
    class: "gif",
    src: artifactUrl(action.latest, gif),
    alt: `The Latest clip of ${action.action}`,
  });
  // What the clip's shape is, so the rail reserves the room the GIF will take
  // rather than jumping when it arrives. It is drawn at the rail's width.
  image.width = gif.width;
  image.height = gif.height;

  return image;
}

/** The Action on the stage: what it last produced, and what it can be asked for. */
function stage(
  app: App,
  handlers: Handlers,
  progress: HTMLElement,
  runAction: HTMLButtonElement | null,
): HTMLElement {
  const trouble = app.trouble === null ? [] : [troublePanel("The app", app.trouble)];

  if (app.projects.length === 0) {
    return el("section", { class: "stage" }, [
      ...trouble,
      el("div", { class: "empty" }, [
        "No Projects are configured in this workspace. One is a directory under ",
        el("code", {}, ["projects/"]),
        " holding a ",
        el("code", {}, ["project.toml"]),
        ".",
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

  return el("section", { class: "stage" }, [
    ...trouble,
    el("div", { class: "stage-head" }, [
      el("h2", {}, [action.action]),
      el("span", { class: "muted" }, [project.configured.name]),
      el("span", { class: "spacer" }),
      button("Run Project", "act", () => handlers.runProject(project.configured.name)),
      ...(runAction === null ? [] : [runAction]),
    ]),
    el("p", { class: "stage-meta" }, [recordedOf(project, action)]),
    progress,
    ...(action.failure === null ? [] : [troublePanel("The Run failed", action.failure)]),
    el("div", { class: "stage-body" }, [clip(action), beside(action)]),
  ]);
}

/** What the Latest was recorded against, so a clip on screen is placeable. */
function recordedOf(project: ProjectState, action: ActionState): string {
  const latest = action.latest;

  if (latest === null) {
    return `${project.configured.baseUrl} · never recorded`;
  }

  return [
    project.configured.baseUrl,
    `recorded ${ago(latest.recordedAt)}`,
    ...(latest.commit === null ? [] : [`commit ${latest.commit.slice(0, 7)}`]),
    `${latest.frames.captured} Frames at ${latest.framerate}fps`,
  ].join(" · ");
}

/**
 * The Latest, playing where it will be embedded. WebM first and the MP4 behind
 * it, exactly as the embed snippet names them (ADR 0006).
 *
 * A failed Run took its own directory away with it, so this is the last good
 * clip whether or not the most recent request for it succeeded.
 */
function clip(action: ActionState): HTMLElement {
  const latest = action.latest;
  const webm = latest === null ? undefined : artifactOf(latest, "webm");
  const mp4 = latest === null ? undefined : artifactOf(latest, "mp4");

  if (latest === null || webm === undefined || mp4 === undefined) {
    return el("div", { class: "empty" }, [
      "Nothing has been recorded for this Action yet. Run it, and the clip plays here.",
    ]);
  }

  const video = el("video", { preload: "metadata" }, [
    el("source", { src: artifactUrl(latest, webm), type: "video/webm" }),
    el("source", { src: artifactUrl(latest, mp4), type: "video/mp4" }),
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
 * The width to the right of the clip, which the layout leaves over: what the
 * Latest produced, and where each of its files is. The previous Run will be
 * compared against it here.
 */
function beside(action: ActionState): HTMLElement {
  const latest = action.latest;

  if (latest === null) {
    return el("aside", { class: "beside" }, [
      el("h3", {}, ["Artifacts"]),
      el("p", { class: "faint" }, ["A Run produces an MP4, a WebM and a GIF."]),
    ]);
  }

  return el("aside", { class: "beside" }, [
    el("h3", {}, ["Artifacts"]),
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
  const action = chosenAction(app);

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
      ? numberControl(parameter, extentOf(parameter), value, tune)
      : parameter.kind === "flag"
        ? [tickBox(parameter, tune)]
        : [menu(parameter, tune)]),
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
 * every write is an Override written to disk -- but the readout follows it, so
 * what is being chosen is legible before it is chosen.
 */
function numberControl(
  parameter: Parameter,
  extent: { readonly min: number; readonly max: number } | undefined,
  readout: HTMLElement,
  tune: (value: ParameterSetting) => void,
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

/** One of a named set, which is what an easing and a choice both are. */
function menu(parameter: Parameter, tune: (value: ParameterSetting) => void): HTMLElement {
  const select = el("select", { id: fieldOf(parameter) });

  for (const choice of parameter.choices ?? []) {
    const option = el("option", { value: choice }, [choice]);
    option.selected = choice === parameter.value;
    select.append(option);
  }

  select.addEventListener("change", () => tune(select.value));

  return select;
}

function tickBox(parameter: Parameter, tune: (value: ParameterSetting) => void): HTMLElement {
  // Named by the Parameter's own name rather than by the label it sits in, which
  // says what it is worth: "cursorCaptions", not "false".
  const box = el("input", {
    id: fieldOf(parameter),
    type: "checkbox",
    "aria-labelledby": labelOf(parameter),
  });

  box.checked = parameter.value === true;
  box.addEventListener("change", () => tune(box.checked));

  return el("label", { class: "ticking" }, [box, String(parameter.value)]);
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
