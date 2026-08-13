/**
 * The Preview player: the running Project in a frame on the stage, driven
 * through the evaluated Timeline.
 *
 * It holds no Timeline logic. The states it plays are the ones `record
 * timeline` answered with, and all this does is decide which of them is showing
 * and tell the page to scroll there -- so a Preview and a Run cannot disagree
 * about what an easing does, because there is only one implementation of one.
 *
 * The frame is created **once** when a Preview is turned on and only ever
 * messaged afterwards. A Parameter change must not put a new frame in the page,
 * exactly as a slider let go of must not put a new video element in it: moving
 * an iframe in the document reloads it, and a Preview that reloaded the site
 * under whoever was tuning it would be a worse loop than the one it replaces.
 */
import type { FrameState, TimelineReport, Viewport } from "./api.js";

/** What the player is showing, for whatever draws the readout beside it. */
export type Showing = {
  readonly at: number;
  readonly of: number;
  readonly playing: boolean;
};

type Standing = {
  /** The Preview origin the Project is proxied at, which is where messages go. */
  readonly origin: string;
  /** What the stage holds, and what is measured to fit the frame into it. */
  readonly root: HTMLElement;
  /** The Project's viewport, laid out at its own size and scaled to fit. */
  readonly page: HTMLElement;
  readonly frame: HTMLIFrameElement;
  readonly fits: ResizeObserver;
  states: readonly FrameState[];
  framerate: number;
  viewport: Viewport;
  at: number;
  playing: boolean;
  /** When the Frame showing now started, which is what paces the replay. */
  since: number;
  /** The rAF this playing is being driven by, or nothing while it is paused. */
  driving: number | null;
  /** Told which Frame is showing, so a readout follows without a repaint. */
  moved: ((showing: Showing) => void) | null;
  /** Whether the driver in the page has said it is listening. */
  ready: boolean;
};

let standing: Standing | null = null;

// The driver says when it is in the page. Until it has, a scroll message would
// arrive before anything was listening for it, so the first Frame is pushed
// again once it does.
window.addEventListener("message", (event) => {
  const said: unknown = event.data;

  if (
    standing === null ||
    event.source !== standing.frame.contentWindow ||
    said === null ||
    typeof said !== "object" ||
    (said as { record?: unknown }).record !== "preview" ||
    (said as { ready?: unknown }).ready !== true
  ) {
    return;
  }

  standing.ready = true;
  drive(standing);
});

/**
 * The element the Preview is played in, made the first time it is asked for and
 * handed back unchanged afterwards -- so redrawing what surrounds it costs the
 * page nothing.
 */
export function playerFor(
  origin: string,
  timeline: TimelineReport,
  moved: (showing: Showing) => void,
): HTMLElement {
  if (standing !== null && standing.origin === origin) {
    standing.moved = moved;
    replay(timeline);

    return standing.root;
  }

  close();

  const root = document.createElement("div");
  root.className = "preview-stage";

  // The Project's own viewport in CSS pixels, so the layout is the layout the
  // clip will have. A Preview at the stage's width would be a Preview of a
  // different page.
  const page = document.createElement("div");
  page.className = "preview-page";

  const frame = document.createElement("iframe");
  frame.className = "preview-frame";
  frame.title = "The Project, played live";
  frame.src = origin;

  page.append(frame);
  root.append(page);

  const fits = new ResizeObserver(() => {
    if (standing !== null) {
      fit(standing);
    }
  });
  fits.observe(root);

  standing = {
    origin,
    root,
    page,
    frame,
    fits,
    states: timeline.states,
    framerate: timeline.framerate,
    viewport: timeline.preview.viewport,
    at: 0,
    playing: true,
    since: performance.now(),
    driving: null,
    moved,
    ready: false,
  };

  fit(standing);
  play(true);

  return root;
}

/**
 * The states to replay, as the Timeline has just been evaluated again.
 *
 * It keeps playing while they are swapped, because the change and the motion
 * have to be the same event: a Parameter found by feel is one whose effect is
 * seen while the hand is still moving.
 */
export function replay(timeline: TimelineReport): void {
  if (standing === null) {
    return;
  }

  standing.states = timeline.states;
  standing.framerate = timeline.framerate;
  standing.viewport = timeline.preview.viewport;
  standing.at = Math.min(standing.at, Math.max(0, timeline.states.length - 1));

  fit(standing);
  drive(standing);
  said(standing);
}

/** Plays the Timeline, looping, or holds it where it has been scrubbed to. */
export function play(playing: boolean): void {
  if (standing === null) {
    return;
  }

  standing.playing = playing;
  standing.since = performance.now();

  if (standing.driving !== null) {
    cancelAnimationFrame(standing.driving);
    standing.driving = null;
  }
  if (playing) {
    standing.driving = requestAnimationFrame(next);
  }

  said(standing);
}

/** Shows one Frame, which is what scrubbing to a moment does. */
export function showFrame(at: number): void {
  if (standing === null) {
    return;
  }

  standing.at = Math.max(0, Math.min(at, standing.states.length - 1));
  standing.since = performance.now();
  drive(standing);
  said(standing);
}

/**
 * Measures the room the stage has and fits the frame into it.
 *
 * Called once the frame is on the page rather than left to the observer alone:
 * an element that has not been put in the document yet measures nothing, so the
 * first fit has to happen after whatever asked for it has drawn.
 */
export function refit(): void {
  if (standing !== null) {
    fit(standing);
  }
}

/** What the player is showing now, or nothing where there is no Preview. */
export function showing(): Showing | null {
  return standing === null
    ? null
    : { at: standing.at, of: standing.states.length, playing: standing.playing };
}

/** Takes the Preview down, which is what giving the stage back to the clips is. */
export function close(): void {
  if (standing === null) {
    return;
  }

  if (standing.driving !== null) {
    cancelAnimationFrame(standing.driving);
  }
  standing.fits.disconnect();
  standing.root.remove();
  standing = null;
}

/**
 * One turn of the replay. Frames are stepped by however many the interval has
 * covered rather than one a turn, so a browser drawing at 60Hz plays a 120fps
 * Timeline at the speed it declares -- and one drawing at 144Hz does not play a
 * 60fps Timeline at twice its length.
 *
 * It is still the browser's refresh rate underneath, which is why framerate is
 * the one Parameter a Preview cannot answer.
 */
function next(now: number): void {
  const playing = standing;

  if (playing === null || !playing.playing) {
    return;
  }

  const interval = 1000 / Math.max(1, playing.framerate);
  const elapsed = now - playing.since;
  const stepped = Math.floor(elapsed / interval);

  if (stepped > 0 && playing.states.length > 0) {
    playing.since += stepped * interval;
    playing.at = (playing.at + stepped) % playing.states.length;
    drive(playing);
    said(playing);
  }

  playing.driving = requestAnimationFrame(next);
}

/** Tells the page where the Frame showing says it is scrolled to, and nothing else. */
function drive(playing: Standing): void {
  const state = playing.states[playing.at];

  if (!playing.ready || state === undefined) {
    return;
  }

  playing.frame.contentWindow?.postMessage(
    { record: "preview", scrollTop: state.scrollTop },
    playing.origin,
  );
}

/**
 * The frame at the Project's viewport, scaled to whatever room the stage has --
 * so that a 1440-wide Project is judgeable on a smaller screen, and a distance
 * chosen here means the same thing in the clip.
 */
function fit(playing: Standing): void {
  const { width, height } = playing.viewport;
  const room = playing.root.clientWidth;
  const scale = room === 0 ? 1 : Math.min(1, room / width);

  playing.page.style.width = `${width}px`;
  playing.page.style.height = `${height}px`;
  playing.page.style.transform = `scale(${scale})`;
  playing.root.style.height = `${Math.round(height * scale)}px`;
}

function said(playing: Standing): void {
  playing.moved?.({ at: playing.at, of: playing.states.length, playing: playing.playing });
}
