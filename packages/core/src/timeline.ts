/**
 * Timeline evaluation: a pure function from a Timeline to the page state of
 * every Frame it produces. Nothing here touches a browser, which is what makes
 * easings, Hold boundaries and duration rounding cheap enough to test.
 *
 * A Frame carries where the page sits and what is done to it before it is
 * drawn. Everything a Timeline can express -- travelling, clicking, typing,
 * waiting -- resolves to those two things, so the browser consumes the Timeline
 * rather than participating in producing it.
 */
import { RecordError } from "./errors.js";
import { keyStroke, type KeyStroke } from "./keys.js";

export type Point = { readonly x: number; readonly y: number };

/** Where the drawn cursor is for one Frame, and whether it is held down. */
export type CursorState = { readonly x: number; readonly y: number; readonly pressed: boolean };

/**
 * Something done to the page before a Frame is drawn. A Frame is still a
 * picture of the page, so what an Action *does* rides alongside the picture
 * rather than inside it.
 */
export type PageEffect =
  | { readonly kind: "cursor-press" }
  | { readonly kind: "cursor-release" }
  | { readonly kind: "key"; readonly stroke: KeyStroke }
  | { readonly kind: "text"; readonly text: string }
  /** The escape hatch: an expression evaluated in the page (ADR 0004). */
  | { readonly kind: "evaluate"; readonly expression: string }
  /** A condition that must hold by now, or the Run fails saying what it waited for. */
  | { readonly kind: "require"; readonly condition: string; readonly describes: string };

/** Where the page is for one Frame, and what happens to it before it is drawn. */
export type PageState = {
  readonly scrollTop: number;
  /** Null in an Action that never moves a cursor, which is most of them. */
  readonly cursor: CursorState | null;
  readonly does: readonly PageEffect[];
};

export type EasingName = "linear" | "ease-in-cubic" | "ease-out-cubic" | "ease-in-out-cubic";

/** A span of Timeline during which nothing moves. */
export type Hold = {
  readonly kind: "hold";
  readonly durationMs: number;
};

/** A span of Timeline that travels to a scroll position along an easing curve. */
export type ScrollTo = {
  readonly kind: "scroll-to";
  readonly scrollTop: number;
  readonly durationMs: number;
  readonly easing: EasingName;
};

/** The same travel, expressed as a distance from wherever the Timeline has reached. */
export type ScrollBy = {
  readonly kind: "scroll-by";
  readonly distance: number;
  readonly durationMs: number;
  readonly easing: EasingName;
};

/** A span of Timeline that carries the cursor to a point in the viewport. */
export type MoveCursor = {
  readonly kind: "move-cursor";
  readonly to: Point;
  readonly durationMs: number;
  readonly easing: EasingName;
};

/** A press and release of the cursor, held down for a declared span. */
export type Click = {
  readonly kind: "click";
  readonly durationMs: number;
};

/** One keystroke, followed by a declared span for the page to answer it in. */
export type Press = {
  readonly kind: "press";
  readonly key: string;
  readonly durationMs: number;
};

/** Text typed one character at a time, each character occupying a span. */
export type Type = {
  readonly kind: "type";
  readonly text: string;
  readonly perKeyMs: number;
};

/**
 * A Hold that the page must have satisfied a condition by the end of. The span
 * is declared rather than measured: a wait whose length depended on how fast
 * the page answered would make the Frame count depend on the machine, which is
 * exactly what deterministic capture rules out.
 */
export type WaitFor = {
  readonly kind: "wait-for";
  readonly condition: string;
  readonly durationMs: number;
  readonly describes: string;
};

/** The escape hatch, taking no time at all. */
export type Evaluate = {
  readonly kind: "evaluate";
  readonly expression: string;
};

export type TimelineSegment =
  | Hold
  | ScrollTo
  | ScrollBy
  | MoveCursor
  | Click
  | Press
  | Type
  | WaitFor
  | Evaluate;

/** Where the page sits before the first segment runs. */
export type TimelineStart = {
  readonly scrollTop: number;
  /** Where the cursor begins. An Action that moves one has to say. */
  readonly cursor?: Point | null;
};

export type Timeline = {
  readonly framerate: number;
  readonly startsAt: TimelineStart;
  readonly segments: readonly TimelineSegment[];
};

const easings: Record<EasingName, (progress: number) => number> = {
  linear: (t) => t,
  "ease-in-cubic": (t) => t * t * t,
  "ease-out-cubic": (t) => 1 - Math.pow(1 - t, 3),
  "ease-in-out-cubic": (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

/** Where the page has reached, before it is told what happens to it next. */
type Position = {
  readonly scrollTop: number;
  readonly cursor: CursorState | null;
};

/**
 * One stretch of Timeline with a single motion in it. Most segments are one
 * span; the ones that press or type are several, so that a state that lasts a
 * moment (a cursor held down) and an instant that has no duration (the release)
 * are the same shape.
 */
type Span = {
  readonly durationMs: number;
  /** Applied before the span's first Frame, or carried onwards if it has none. */
  readonly does?: readonly PageEffect[];
  /** Applied before the span's last Frame -- what a wait's condition is checked at. */
  readonly ends?: readonly PageEffect[];
  /** Where the page sits once the span is over. */
  readonly to: (from: Position) => Position;
  /** Where the page sits partway through. Still, unless a span says otherwise. */
  readonly at?: (from: Position, progress: number) => Position;
};

const still = (from: Position): Position => from;

/**
 * The page state of each Frame the Timeline produces, in order.
 *
 * A segment's Frames sample its motion from where the Timeline has reached up
 * to but not including its destination, so the destination belongs to whatever
 * comes next -- which is what lets a Hold after a travel be a still image
 * rather than a frame of leftover motion. A segment too short to occupy a whole
 * Frame therefore still moves the Timeline on, and what it does to the page is
 * carried to the next Frame rather than lost.
 */
export function evaluateTimeline(timeline: Timeline): PageState[] {
  const frames: PageState[] = [];
  let reached: Position = {
    scrollTop: timeline.startsAt.scrollTop,
    cursor: startingCursor(timeline.startsAt.cursor),
  };
  let carried: readonly PageEffect[] = [];

  for (const segment of timeline.segments) {
    for (const span of spansOf(segment)) {
      const count = frameCount(span.durationMs, timeline.framerate);
      const at = span.at ?? still;

      if (count === 0) {
        carried = [...carried, ...(span.does ?? []), ...(span.ends ?? [])];
      } else {
        for (let frame = 0; frame < count; frame++) {
          frames.push({
            ...at(reached, frame / count),
            does: [
              ...(frame === 0 ? [...carried, ...(span.does ?? [])] : []),
              ...(frame === count - 1 ? (span.ends ?? []) : []),
            ],
          });
        }
        carried = [];
      }

      reached = span.to(reached);
    }
  }

  // Anything still carried happens after the last Frame, where no camera is
  // looking: releasing a cursor the clip has already stopped watching changes
  // nothing anyone can see.
  return frames;
}

/** What one segment does, as the spans it breaks into. */
function spansOf(segment: TimelineSegment): readonly Span[] {
  switch (segment.kind) {
    case "hold":
      return [{ durationMs: segment.durationMs, to: still }];
    case "scroll-to":
      return [travelling(segment.durationMs, segment.easing, () => segment.scrollTop)];
    case "scroll-by":
      return [travelling(segment.durationMs, segment.easing, (from) => from.scrollTop + segment.distance)];
    case "move-cursor":
      return [carrying(segment)];
    case "click":
      return [
        { durationMs: 0, does: [{ kind: "cursor-press" }], to: (from) => held(from, true) },
        { durationMs: segment.durationMs, to: still },
        { durationMs: 0, does: [{ kind: "cursor-release" }], to: (from) => held(from, false) },
      ];
    case "press":
      return [
        {
          durationMs: segment.durationMs,
          does: [{ kind: "key", stroke: keyStroke(segment.key) }],
          to: still,
        },
      ];
    case "type":
      return [...segment.text].map((character) => ({
        durationMs: segment.perKeyMs,
        does: [{ kind: "text", text: character } as const],
        to: still,
      }));
    case "wait-for":
      return [
        {
          durationMs: segment.durationMs,
          ends: [
            { kind: "require", condition: segment.condition, describes: segment.describes },
          ],
          to: still,
        },
      ];
    case "evaluate":
      return [
        { durationMs: 0, does: [{ kind: "evaluate", expression: segment.expression }], to: still },
      ];
  }
}

/** A span that travels the page to a scroll position the Timeline decides. */
function travelling(
  durationMs: number,
  easing: EasingName,
  destination: (from: Position) => number,
): Span {
  const ease = easings[easing];

  return {
    durationMs,
    to: (from) => ({ ...from, scrollTop: Math.round(destination(from)) }),
    at: (from, progress) => ({
      ...from,
      scrollTop: pixels(from.scrollTop, Math.round(destination(from)), ease(progress)),
    }),
  };
}

/** A span that carries the cursor across the viewport. */
function carrying(segment: MoveCursor): Span {
  const ease = easings[segment.easing];
  const destination = { x: Math.round(segment.to.x), y: Math.round(segment.to.y) };

  return {
    durationMs: segment.durationMs,
    to: (from) => ({ ...from, cursor: { ...cursorOf(from, "moves the cursor"), ...destination } }),
    at: (from, progress) => {
      const cursor = cursorOf(from, "moves the cursor");
      return {
        ...from,
        cursor: {
          x: pixels(cursor.x, destination.x, ease(progress)),
          y: pixels(cursor.y, destination.y, ease(progress)),
          pressed: cursor.pressed,
        },
      };
    },
  };
}

function held(from: Position, pressed: boolean): Position {
  return { ...from, cursor: { ...cursorOf(from, "clicks"), pressed } };
}

/**
 * A cursor has to start somewhere: it is drawn into the page rather than owned
 * by the machine, so no Action can be asked where it "already" is.
 */
function cursorOf(from: Position, what: string): CursorState {
  if (from.cursor === null) {
    throw new RecordError(`an Action that ${what} must declare where the cursor starts`);
  }
  return from.cursor;
}

function startingCursor(point: Point | null | undefined): CursorState | null {
  return point == null ? null : { x: Math.round(point.x), y: Math.round(point.y), pressed: false };
}

/**
 * Chromium rounds scrollTop to whole CSS pixels regardless of device pixel
 * ratio (ADR 0008), so an evaluated page state carrying a fraction would
 * describe a position the page cannot occupy. The cursor is drawn into the page
 * and rounded with it, so that two Runs cannot disagree in a half pixel.
 */
function pixels(from: number, to: number, eased: number): number {
  return Math.round(from + (to - from) * eased);
}

/**
 * A declared duration is rounded to the nearest whole number of Frames, since
 * a Frame boundary cannot fall inside a frame interval.
 */
function frameCount(durationMs: number, framerate: number): number {
  return Math.round((durationMs * framerate) / 1000);
}
