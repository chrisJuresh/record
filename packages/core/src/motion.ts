/**
 * The motion primitives an Action builds its Timeline from (ADR 0004). Each one
 * appends a segment and hands back a Timeline, so an Action reads as the motion
 * it performs rather than as a list of literals.
 *
 * Everything here is a description. Nothing runs until the Timeline is
 * evaluated, and nothing evaluated needs a browser.
 */
import type {
  EasingName,
  Point,
  Timeline,
  TimelineSegment,
  TimelineStart,
} from "./timeline.js";

/** How long a travelling segment takes, and how it accelerates and settles. */
export type Travel = {
  readonly durationMs: number;
  readonly easing?: EasingName;
};

/**
 * A Timeline under construction. It is a Timeline already -- each primitive
 * returns a new one -- so an Action can return the chain it built.
 */
export type Motion = Timeline & {
  /** Stay still. A Hold at either end is what stops a looping clip snapping back. */
  hold(durationMs: number): Motion;
  /** Travel to a scroll position. */
  scrollTo(scrollTop: number, travel: Travel): Motion;
  /** Travel by a distance from wherever the Timeline has reached. */
  scrollBy(distance: number, travel: Travel): Motion;
  /** Carry the cursor to a point in the viewport, in CSS pixels. */
  moveCursorTo(point: Point, travel: Travel): Motion;
  /** Press and release the cursor where it is, held down for a moment. */
  click(options?: { readonly durationMs?: number }): Motion;
  /** Press one named key, then wait for the page to answer it. */
  press(key: string, options?: { readonly durationMs?: number }): Motion;
  /** Type text one character at a time into whatever has focus. */
  type(text: string, options?: { readonly perKeyMs?: number }): Motion;
  /** Hold, and fail the Run if the condition has not become true by the end of it. */
  waitFor(
    condition: string,
    options: { readonly durationMs: number; readonly describes?: string },
  ): Motion;
  /** The escape hatch: an expression evaluated in the page, taking no time. */
  evaluate(expression: string): Motion;
};

export type MotionOptions = {
  readonly framerate: number;
  readonly startsAt?: TimelineStart;
};

/** Travel eases at both ends unless an Action asks for something else. */
const defaultEasing: EasingName = "ease-in-out-cubic";

/** How long a cursor stays down, long enough to read as a press at any framerate. */
const defaultClickMs = 120;

/** How long a keystroke is given for the page to answer it. */
const defaultPressMs = 120;

/** How long each typed character takes, at somewhere near a person's pace. */
const defaultPerKeyMs = 90;

const startsAtTheTop: TimelineStart = { scrollTop: 0, cursor: null };

/** Begins a Timeline. Every primitive called on it returns another one. */
export function motion(options: MotionOptions): Motion {
  return extending(options.framerate, options.startsAt ?? startsAtTheTop, []);
}

function extending(
  framerate: number,
  startsAt: TimelineStart,
  segments: readonly TimelineSegment[],
): Motion {
  const then = (segment: TimelineSegment): Motion =>
    extending(framerate, startsAt, [...segments, segment]);

  return {
    framerate,
    startsAt,
    segments,
    hold: (durationMs) => then({ kind: "hold", durationMs }),
    scrollTo: (scrollTop, travel) =>
      then({ kind: "scroll-to", scrollTop, durationMs: travel.durationMs, easing: easingOf(travel) }),
    scrollBy: (distance, travel) =>
      then({ kind: "scroll-by", distance, durationMs: travel.durationMs, easing: easingOf(travel) }),
    moveCursorTo: (point, travel) =>
      then({ kind: "move-cursor", to: point, durationMs: travel.durationMs, easing: easingOf(travel) }),
    click: (options) => then({ kind: "click", durationMs: options?.durationMs ?? defaultClickMs }),
    press: (key, options) =>
      then({ kind: "press", key, durationMs: options?.durationMs ?? defaultPressMs }),
    type: (text, options) =>
      then({ kind: "type", text, perKeyMs: options?.perKeyMs ?? defaultPerKeyMs }),
    waitFor: (condition, options) =>
      then({
        kind: "wait-for",
        condition,
        durationMs: options.durationMs,
        describes: options.describes ?? condition,
      }),
    evaluate: (expression) => then({ kind: "evaluate", expression }),
  };
}

function easingOf(travel: Travel): EasingName {
  return travel.easing ?? defaultEasing;
}
