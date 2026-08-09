/**
 * Timeline evaluation: a pure function from a Timeline to the page state of
 * every Frame it produces. Nothing here touches a browser, which is what makes
 * easings, Hold boundaries and duration rounding cheap enough to test.
 */

/** Where the page is for one Frame. */
export type PageState = {
  readonly scrollTop: number;
};

/** A span of Timeline during which nothing moves. */
export type Hold = {
  readonly kind: "hold";
  readonly durationMs: number;
};

export type TimelineSegment = Hold;

export type Timeline = {
  readonly framerate: number;
  /** Where the page sits before the first segment runs. */
  readonly startsAt: PageState;
  readonly segments: readonly TimelineSegment[];
};

/** The page state of each Frame the Timeline produces, in order. */
export function evaluateTimeline(timeline: Timeline): PageState[] {
  const frames: PageState[] = [];

  for (const segment of timeline.segments) {
    const held = frames.at(-1) ?? timeline.startsAt;
    for (let frame = 0; frame < frameCount(segment.durationMs, timeline.framerate); frame++) {
      frames.push(held);
    }
  }

  return frames;
}

/**
 * A declared duration is rounded to the nearest whole number of Frames, since
 * a Frame boundary cannot fall inside a frame interval.
 */
function frameCount(durationMs: number, framerate: number): number {
  return Math.round((durationMs * framerate) / 1000);
}
