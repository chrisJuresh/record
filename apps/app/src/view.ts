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
import { artifactUrl, embedUrl, type Artifact, type Run } from "./api.js";
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
};

let live: Live | undefined;

/** Draws the whole app. */
export function paint(root: HTMLElement, app: App, handlers: Handlers): void {
  const badges = new Map<string, HTMLElement>();
  const tally = el("span", { class: "faint" }, [tallyOf(app)]);
  const progress = el("div", { class: "progress" });

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
    ]),
  );

  live = { tally, badges, progress, runAction };
  paintProgress(app);
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
