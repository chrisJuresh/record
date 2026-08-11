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
  actionsIn,
  asking,
  ended,
  nothingYet,
  progressed,
  type ActionState,
  type App,
  type ProjectState,
} from "./model.js";
import { paint, paintProgress, type Handlers } from "./view.js";

/** Where the rail's clips being on or off is remembered between openings. */
const thumbnailsKept = "record.thumbnails";

const root = pageRoot();
const app = nothingYet(remembered(thumbnailsKept) ?? true);

const handlers: Handlers = {
  choose(project, action) {
    app.chosen = { project, action };
    repaint();
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

  showThumbnails(showing) {
    app.thumbnails = showing;
    remember(thumbnailsKept, showing);
    repaint();
  },
};

repaint();
void settle();

/** The page the app is drawn into, which the shell it is served with carries. */
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
 */
async function settle(): Promise<void> {
  try {
    app.projects = await Promise.all((await api.projects()).map(read));
    app.chosen = firstAction(app.projects);
    app.trouble = null;
  } catch (failure) {
    app.trouble = messageOf(failure);
  }

  repaint();
}

async function read(project: api.Project): Promise<ProjectState> {
  const named = await api.actions(project.name);

  return {
    project,
    actions: await Promise.all(named.map((action) => readAction(project.name, action))),
  };
}

async function readAction(project: string, action: string): Promise<ActionState> {
  // Newest first, so the Latest is the first of them -- and an Action nobody has
  // run keeps none at all, which is a state rather than a failure.
  const kept = await api.history(project, action);

  return { project, action, latest: kept[0] ?? null, doing: null, failure: null };
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
async function ask(asked: api.Ask): Promise<void> {
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

function repaint(): void {
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
