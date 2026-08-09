/**
 * Timeline evaluation: a pure function from a Timeline to the page state of
 * every Frame it produces. Nothing here touches a browser, which is what makes
 * easings, Hold boundaries and duration rounding cheap enough to test.
 */

/** Where the page is for one Frame. */
export type PageState = {
  readonly scrollTop: number;
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

export type TimelineSegment = Hold | ScrollTo;

export type Timeline = {
  readonly framerate: number;
  /** Where the page sits before the first segment runs. */
  readonly startsAt: PageState;
  readonly segments: readonly TimelineSegment[];
};

const easings: Record<EasingName, (progress: number) => number> = {
  linear: (t) => t,
  "ease-in-cubic": (t) => t * t * t,
  "ease-out-cubic": (t) => 1 - Math.pow(1 - t, 3),
  "ease-in-out-cubic": (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

/**
 * The page state of each Frame the Timeline produces, in order.
 *
 * A segment's Frames sample its motion from where the Timeline has reached up
 * to but not including its destination, so the destination belongs to whatever
 * comes next -- which is what lets a Hold after a travel be a still image
 * rather than a frame of leftover motion. A segment too short to occupy a whole
 * Frame therefore still moves the Timeline on.
 */
export function evaluateTimeline(timeline: Timeline): PageState[] {
  const frames: PageState[] = [];
  let reached = timeline.startsAt;

  for (const segment of timeline.segments) {
    const motion = motionOf(segment, reached);
    const count = frameCount(segment.durationMs, timeline.framerate);

    for (let frame = 0; frame < count; frame++) {
      frames.push(motion.at(frame / count));
    }

    reached = motion.destination;
  }

  return frames;
}

/** What one segment does, from where the Timeline has reached: where it ends, and how it gets there. */
function motionOf(
  segment: TimelineSegment,
  from: PageState,
): { destination: PageState; at: (progress: number) => PageState } {
  switch (segment.kind) {
    case "hold":
      return { destination: from, at: () => from };
    case "scroll-to": {
      const destination = { scrollTop: Math.round(segment.scrollTop) };
      const ease = easings[segment.easing];
      return {
        destination,
        at: (progress) => ({ scrollTop: pixels(from.scrollTop, destination.scrollTop, ease(progress)) }),
      };
    }
  }
}

/**
 * Chromium rounds scrollTop to whole CSS pixels regardless of device pixel
 * ratio (ADR 0008), so an evaluated page state carrying a fraction would
 * describe a position the page cannot occupy.
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
