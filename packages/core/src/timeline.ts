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
import { characterStroke, keyStroke, strokeLabel, type Key, type KeyStroke } from "./keys.js";

export type Point = { readonly x: number; readonly y: number };

/**
 * A ring spreading from where a click landed. It keeps its own place, because
 * a click marks where it happened however far the cursor travels on afterwards.
 */
export type Ripple = {
  readonly x: number;
  readonly y: number;
  /** How far it has spread: 0 on the Frame of the press, approaching 1 as it fades. */
  readonly spread: number;
};

/**
 * Where the cursor is for one Frame, whether it is held down, and what its
 * clicks are still sending out.
 *
 * This is the state a cursor is drawn from -- no Frame contains the operating
 * system's pointer, so one has to be drawn into the page. It is not how a click
 * reaches the page: a click is an event, and an event shorter than a Frame
 * still has to happen, which a state read once per Frame could not express.
 */
export type CursorState = {
  readonly x: number;
  readonly y: number;
  readonly pressed: boolean;
  /**
   * The ripples a click is still sending out, oldest first. Decided here so
   * that a click looks the same in every Run of the Action -- an animation left
   * to the page would look like whatever the page felt like that time.
   */
  readonly ripples: readonly Ripple[];
};

/** How long a click's ripple takes to spread and fade, whatever the framerate. */
const clickRippleMs = 320;

/** How long a caption stays up after the last key struck into it. */
const captionLingerMs = 600;

/**
 * Something done to the page before a Frame is drawn. A Frame is still a
 * picture of the page, so what an Action *does* rides alongside the picture
 * rather than inside it.
 */
export type PageEffect =
  | { readonly kind: "cursor-press" }
  | { readonly kind: "cursor-release" }
  | { readonly kind: "key"; readonly stroke: KeyStroke }
  /** The escape hatch: an expression evaluated in the page (ADR 0004). */
  | { readonly kind: "evaluate"; readonly expression: string }
  /** A condition that must hold by now, or the Run fails saying what it waited for. */
  | { readonly kind: "require"; readonly condition: string; readonly describes: string };

/** Where the page is for one Frame, and what happens to it before it is drawn. */
export type PageState = {
  readonly scrollTop: number;
  /** Null in an Action that never moves a cursor, which is most of them. */
  readonly cursor: CursorState | null;
  /**
   * The keys struck around this Frame, as they would read on screen, or null
   * where none were. Every Frame carries them; whether they are drawn is a
   * Parameter, so that turning captions on is not a second Timeline.
   */
  readonly caption: string | null;
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
  readonly key: Key;
  readonly durationMs: number;
};

/** Text typed one character at a time, each character occupying a span. */
export type Typing = {
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
  | Typing
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

/**
 * Where the cursor has reached, before the ripples its clicks send out have
 * been worked out -- those depend on the Frames around one, and a segment knows
 * only about itself.
 */
type Pointer = { readonly x: number; readonly y: number; readonly pressed: boolean };

/** Where the page has reached, before it is told what happens to it next. */
type Position = {
  readonly scrollTop: number;
  readonly cursor: Pointer | null;
};

/** One Frame as its own segment left it, before the drawn cursor is worked out. */
type Placed = Position & { readonly does: readonly PageEffect[] };

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
  const frames: Placed[] = [];
  let reached: Position = {
    scrollTop: timeline.startsAt.scrollTop,
    cursor: startingCursor(timeline.startsAt.cursor),
  };
  let carried: readonly PageEffect[] = [];

  for (const segment of timeline.segments) {
    assertWaitsLongEnough(segment, timeline.framerate);

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
  return drawnOver(frames, timeline.framerate);
}

/**
 * What each Frame shows of the click ripples and the keys struck. This is the
 * one part of a Frame that depends on the Frames around it -- a ripple outlives
 * the press that sent it and a caption outlives the key that wrote it -- so
 * both are worked out over the whole run of Frames rather than inside a
 * segment, one pass each.
 */
function drawnOver(frames: readonly Placed[], framerate: number): PageState[] {
  const spreading = ripplesOf(frames, framerate);
  const captions = captionsOf(frames, framerate);

  return frames.map((frame, at) => ({
    scrollTop: frame.scrollTop,
    cursor: frame.cursor === null ? null : { ...frame.cursor, ripples: spreading[at] ?? [] },
    caption: captions[at] ?? null,
    does: frame.does,
  }));
}

/**
 * The ripples alight on each Frame, each still where the click that sent it
 * landed. A press is only ever on a Frame that has a cursor, because an Action
 * that clicks has to have declared where the cursor starts.
 */
function ripplesOf(frames: readonly Placed[], framerate: number): Ripple[][] {
  const lasts = Math.max(1, frameCount(clickRippleMs, framerate));
  const pressed: { readonly at: number; readonly x: number; readonly y: number }[] = [];

  return frames.map((frame, at) => {
    if (frame.cursor !== null && frame.does.some((effect) => effect.kind === "cursor-press")) {
      pressed.push({ at, x: frame.cursor.x, y: frame.cursor.y });
    }
    while (pressed.length > 0 && at - (pressed[0]?.at ?? at) >= lasts) {
      pressed.shift();
    }

    // Rounded to thousandths, so that what is drawn is a number rather than a
    // float's tail.
    return pressed.map(({ at: sent, x, y }) => ({
      x,
      y,
      spread: Math.round(((at - sent) / lasts) * 1000) / 1000,
    }));
  });
}

/**
 * The caption on each Frame: the burst of keystrokes it belongs to, staying up
 * for a moment after the last of them, and nothing where no key was struck
 * near enough to it.
 */
function captionsOf(frames: readonly Placed[], framerate: number): (string | null)[] {
  const lingers = Math.max(1, frameCount(captionLingerMs, framerate));
  let struck: string[] = [];
  let showsUntil = 0;

  return frames.map((frame, at) => {
    const labels = frame.does
      .filter((effect) => effect.kind === "key")
      .map((effect) => strokeLabel(effect.stroke));

    if (labels.length > 0) {
      struck = at < showsUntil ? [...struck, ...labels] : labels;
      showsUntil = at + lingers;
    }

    return at < showsUntil ? captionOf(struck) : null;
  });
}

/**
 * A burst of keystrokes as one line: characters run together into the word they
 * typed, and a key with a name of its own held apart from them.
 */
function captionOf(labels: readonly string[]): string {
  return labels
    .map((label, at) => {
      const before = labels[at - 1];
      return at > 0 && (label.length > 1 || (before?.length ?? 0) > 1) ? ` ${label}` : label;
    })
    .join("");
}

/**
 * A wait is checked on the last Frame of its own span, so a wait too short to
 * occupy a Frame would be a Run that passed without ever having looked. That is
 * the one thing a wait must not do, so it is refused rather than rounded away.
 */
function assertWaitsLongEnough(segment: TimelineSegment, framerate: number): void {
  if (segment.kind === "wait-for" && frameCount(segment.durationMs, framerate) === 0) {
    throw new RecordError(
      `waiting for ${segment.describes} was given ${segment.durationMs}ms, which is less than ` +
        `one Frame at ${framerate}fps -- it would never be checked`,
    );
  }
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
        does: [{ kind: "key", stroke: characterStroke(character) } as const],
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
 * A cursor has to start somewhere: no Frame contains the operating system's
 * pointer, so there is no "already" for an Action to be asked about.
 */
function cursorOf(from: Position, what: string): Pointer {
  if (from.cursor === null) {
    throw new RecordError(`an Action that ${what} must declare where the cursor starts`);
  }
  return from.cursor;
}

function startingCursor(point: Point | null | undefined): Pointer | null {
  return point == null ? null : { x: Math.round(point.x), y: Math.round(point.y), pressed: false };
}

/**
 * Chromium rounds scrollTop to whole CSS pixels regardless of device pixel
 * ratio (ADR 0008), so an evaluated page state carrying a fraction would
 * describe a position the page cannot occupy. Cursor positions are rounded
 * alongside it, so that two Runs cannot disagree over half a pixel.
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
