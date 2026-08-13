/**
 * The evaluated Timeline, exposed rather than reimplemented -- and everything a
 * Preview of it needs.
 *
 * A Preview is the Action played live against the running Project, in the app,
 * with no capture and no encoding anywhere in the loop. The app replays what is
 * reported here; it evaluates nothing of its own, because a second
 * implementation of an easing is a Preview that would eventually lie about the
 * clip. This is the same evaluation a Run uses, so a Preview and a Run cannot
 * disagree about what a travel does.
 *
 * Nothing here writes. Named values are evaluated **as if** they applied, which
 * is the difference between scrubbing and tuning: the app asks for evaluations
 * continuously while a control is moving, and writes an Override only once the
 * person settles on a value.
 */
import { allParameters, effectiveParameters, loadAction, overrideFrom } from "./action.js";
import { actionModule, readProject, type Viewport } from "./config.js";
import { RecordError } from "./errors.js";
import { answers, readyUrl } from "./lifecycle.js";
import { readOverrides } from "./overrides.js";
import { findScroller, stopSmoothScrolling } from "./page.js";
import type { ParameterSetting } from "./settings.js";
import { evaluateTimeline, type PageState, type Timeline, type TimelineSegment } from "./timeline.js";

/**
 * Why each primitive stops a Preview, in the words the person tuning reads.
 *
 * A Preview drives the **live** Project, so anything that would really happen
 * to the running site is refused rather than half-played: tuning an Action must
 * never be able to triage a photograph. A wait is refused for the other reason
 * -- nothing here evaluates a condition in the page, and an Action that skipped
 * the part it waits for is not the motion anybody wanted to judge.
 */
const stoppedBy: Partial<Record<TimelineSegment["kind"], string>> = {
  click: "'.click()' presses the cursor into the running Project",
  press: "'.press()' strikes a key in the running Project",
  type: "'.type()' types into the running Project",
  evaluate: "'.evaluate()' runs an expression in the running Project",
  "wait-for": "'.waitFor()' checks a condition in the running Project, which a Preview cannot do",
};

/**
 * What is injected into the Project's page so that the app can drive it.
 *
 * It comes from here rather than from the server for a reason beyond tidiness:
 * it has to find the scroller the way capture finds it and disable smooth
 * scrolling the way capture disables it, or a Preview scrolls a different
 * element than the clip does. Both come from the same expressions capture uses.
 *
 * It scrolls and does nothing else. There is no path through it by which a
 * Preview could click, type or evaluate anything in the page -- which is the
 * other half of what protects a real photo library, the first half being the
 * refusal above.
 */
export const previewDriver = `
(() => {
  ${stopSmoothScrolling};

  /** Whichever element actually scrolls, found the way capture finds it. */
  const scroller = () => {
    const found = window.__recordScroller;
    if (found === undefined || found === null || !found.isConnected) {
      ${findScroller};
    }
    return window.__recordScroller;
  };

  const tell = (message) => {
    try {
      window.parent.postMessage(message, "*");
    } catch {
      // Nobody to tell, which is a page opened on its own rather than a failure.
    }
  };

  window.addEventListener("message", (event) => {
    // Only whoever put this page in a frame drives it.
    if (event.source !== window.parent) {
      return;
    }

    const asked = event.data;
    if (asked === null || typeof asked !== "object" || asked.record !== "preview") {
      return;
    }
    if (typeof asked.scrollTop === "number") {
      scroller().scrollTop = asked.scrollTop;
    }
  });

  // Found again once the page has finished loading: which element scrolls is
  // decided by content that may not have arrived when this ran.
  const settled = () => {
    window.__recordScroller = null;
    scroller();
    tell({ record: "preview", ready: true });
  };

  if (document.readyState === "complete") {
    settled();
  } else {
    window.addEventListener("load", settled);
  }

  scroller();
  tell({ record: "preview", ready: true });
})()
`;

/** Whether a Timeline can be played against the live Project, and what stops it. */
export type Previewability = {
  readonly previewable: boolean;
  /** In the words the person reads, and nothing where it can be previewed. */
  readonly refusal: string | null;
};

/** What a Preview of an Action needs, beside the Timeline it replays. */
export type PreviewReport = Previewability & {
  /** Where the Project answers, which is what the Preview origin proxies. */
  readonly baseUrl: string;
  /** ...and where it has to be answering already, since a Preview starts nothing. */
  readonly readyUrl: string;
  /** The viewport the Preview is shown at, which is the Project's own. */
  readonly viewport: Viewport;
  /** The expression injected into the Project's page to drive it. */
  readonly driver: string;
};

/** What an Action's Timeline comes to, and what a Preview of it would need. */
export type TimelineReport = {
  readonly project: string;
  readonly action: string;
  readonly framerate: number;
  /** How long it runs, which is its Frames at its framerate. */
  readonly durationMs: number;
  /** How many Frames a Run of it would capture. */
  readonly frames: number;
  /**
   * Where the page is on every Frame, and what happens to it before that Frame
   * is drawn. The app plays these back; it works none of them out.
   */
  readonly states: readonly PageState[];
  /** What it was evaluated with, declarations, Overrides and named values together. */
  readonly parameters: Readonly<Record<string, ParameterSetting>>;
  /** Which of those did not come from the declaration. */
  readonly overridden: readonly string[];
  /**
   * The names given to this command, evaluated as if they applied and written
   * nowhere -- a slider being dragged, rather than a value settled on.
   */
  readonly named: readonly string[];
  /** Overrides that could not be applied, said rather than dropped. */
  readonly warnings: readonly string[];
  readonly preview: PreviewReport;
};

export type TimelineOptions = {
  /** `name=value` evaluated as if it applied. Nothing is written, ever. */
  readonly set?: readonly string[];
  /**
   * Whether this is a Preview being turned on rather than a Timeline being
   * read. It refuses an Action that cannot be previewed, and a Project that is
   * not answering -- and it never starts one, because a Preview has no reliable
   * moment of ending to stop it at.
   */
  readonly forPreview?: boolean;
};

/**
 * What an Action's Timeline evaluates to: its framerate, how long it runs, how
 * many Frames it declares, and the per-Frame page states a Run captures from.
 */
export async function readTimeline(
  workspace: string,
  project: string,
  action: string,
  options: TimelineOptions = {},
): Promise<TimelineReport> {
  const configured = await readProject(workspace, project);
  const module = await loadAction(await actionModule(workspace, project, action));
  const declared = allParameters(module, configured);

  const sidecar = await readOverrides(workspace, project, action);
  const named: Record<string, ParameterSetting> = {};

  for (const assignment of options.set ?? []) {
    const at = assignment.indexOf("=");
    if (at <= 0) {
      throw new RecordError(`a named value is written name=value, not '${assignment}'`);
    }
    const name = assignment.slice(0, at);
    named[name] = overrideFrom(declared, name, assignment.slice(at + 1));
  }

  const effective = effectiveParameters(declared, { ...sidecar, ...named });
  const timeline = module.timeline(effective.values);
  const states = evaluateTimeline(timeline);

  const previewable = previewabilityOf(timeline);
  const url = readyUrl(configured);

  if (options.forPreview === true) {
    await assertPreviewable(configured.name, url, previewable);
  }

  return {
    project,
    action,
    framerate: timeline.framerate,
    // Worked out from the Frames rather than from the declared durations: a
    // duration is rounded to whole Frames on the way in, so the Frames are what
    // the clip will actually run for.
    durationMs: Math.round((states.length / timeline.framerate) * 1000),
    frames: states.length,
    states,
    parameters: effective.values as Readonly<Record<string, ParameterSetting>>,
    overridden: effective.overridden,
    named: Object.keys(named),
    warnings: effective.warnings,
    preview: {
      ...previewable,
      baseUrl: configured.baseUrl,
      readyUrl: url,
      viewport: configured.viewport,
      driver: previewDriver,
    },
  };
}

/**
 * Whether a Timeline can be played against the live Project.
 *
 * The rule lives with the evaluation rather than in the app, because it is what
 * stops tuning an Action from clicking around somebody's real site: the app
 * obeys and displays, and never decides.
 */
export function previewabilityOf(timeline: Timeline): Previewability {
  for (const segment of timeline.segments) {
    const stops = stoppedBy[segment.kind];

    if (stops !== undefined) {
      return {
        previewable: false,
        refusal:
          `this Action cannot be previewed: ${stops}, and a Preview drives the live site ` +
          "rather than a browser of its own. Record it to see this Action.",
      };
    }
  }

  return { previewable: true, refusal: null };
}

/**
 * Refuses a Preview that would drive the running Project wrongly, or one there
 * is no Project to drive. Both are said before an origin is allocated or a
 * frame is put in the page, so a Preview never half-starts.
 */
async function assertPreviewable(
  project: string,
  url: string,
  previewable: Previewability,
): Promise<void> {
  if (previewable.refusal !== null) {
    throw new RecordError(previewable.refusal);
  }

  if (!(await answers(url))) {
    throw new RecordError(
      `Project '${project}' is not answering at ${url}, so there is nothing to preview ` +
        "against. A Preview never starts a Project -- start it and ask again.",
    );
  }
}
