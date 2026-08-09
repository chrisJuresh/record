/**
 * The Timeline evaluation seam. Easings, Hold boundaries and duration rounding
 * are asserted here rather than through a browser, because a Chromium launch
 * per easing is how such assertions stop being run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateTimeline, type EasingName } from "../src/timeline.js";

/** The scroll position of every Frame a single travelling segment produces. */
function travel(easing: EasingName, distance: number, frames: number): number[] {
  return evaluateTimeline({
    framerate: 10,
    startsAt: { scrollTop: 0 },
    segments: [{ kind: "scroll-to", scrollTop: distance, durationMs: frames * 100, easing }],
  }).map((frame) => frame.scrollTop);
}

test("a Hold occupies one Frame per frame interval and nothing moves", () => {
  const frames = evaluateTimeline({
    framerate: 60,
    startsAt: { scrollTop: 0 },
    segments: [{ kind: "hold", durationMs: 400 }],
  });

  // 0.4s at 60fps.
  assert.equal(frames.length, 24);
  assert.deepEqual([...new Set(frames.map((frame) => frame.scrollTop))], [0]);
});

test("consecutive Holds run one after the other from where the Timeline starts", () => {
  const frames = evaluateTimeline({
    framerate: 30,
    startsAt: { scrollTop: 180 },
    segments: [
      { kind: "hold", durationMs: 400 },
      { kind: "hold", durationMs: 250 },
    ],
  });

  // 0.4s and 0.25s at 30fps: 12 Frames then 8 (7.5 rounded).
  assert.equal(frames.length, 20);
  assert.deepEqual(frames.at(0), { scrollTop: 180 });
  assert.deepEqual(frames.at(-1), { scrollTop: 180 });
});

test("a linear scroll advances by an equal step every Frame", () => {
  assert.deepEqual(travel("linear", 100, 10), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
});

test("each easing curve bends the same travel its own way", () => {
  // Slow to start, still gaining speed at the end.
  assert.deepEqual(travel("ease-in-cubic", 1000, 10), [0, 1, 8, 27, 64, 125, 216, 343, 512, 729]);

  // Fastest immediately, easing off towards the destination.
  assert.deepEqual(travel("ease-out-cubic", 1000, 10), [0, 271, 488, 657, 784, 875, 936, 973, 992, 999]);

  // Slow at both ends, fastest across the middle -- and symmetric about it.
  assert.deepEqual(travel("ease-in-out-cubic", 1000, 10), [0, 4, 32, 108, 256, 500, 744, 892, 968, 996]);
});

/**
 * The travelling segment stops one step short of its destination, and the Hold
 * after it sits on the destination itself -- so a Hold is a still image rather
 * than a frame of leftover motion.
 */
test("a Hold after a scroll holds at the destination, not at the last moving Frame", () => {
  const frames = evaluateTimeline({
    framerate: 10,
    startsAt: { scrollTop: 0 },
    segments: [
      { kind: "scroll-to", scrollTop: 100, durationMs: 500, easing: "linear" },
      { kind: "hold", durationMs: 300 },
    ],
  });

  assert.deepEqual(
    frames.map((frame) => frame.scrollTop),
    [0, 20, 40, 60, 80, 100, 100, 100],
  );
});

test("a scroll starts from wherever the Timeline has reached, in either direction", () => {
  const frames = evaluateTimeline({
    framerate: 10,
    startsAt: { scrollTop: 0 },
    segments: [
      { kind: "scroll-to", scrollTop: 200, durationMs: 200, easing: "linear" },
      { kind: "scroll-to", scrollTop: 0, durationMs: 200, easing: "linear" },
    ],
  });

  assert.deepEqual(
    frames.map((frame) => frame.scrollTop),
    [0, 100, 200, 100],
  );
});

/**
 * Chromium rounds scrollTop to whole CSS pixels (ADR 0008), so an evaluated
 * page state carrying a fraction would describe a position the page cannot
 * occupy.
 */
test("a page state is a whole CSS pixel, because that is the finest the page can hold", () => {
  const frames = travel("linear", 10, 8);

  assert.deepEqual(frames, [0, 1, 3, 4, 5, 6, 8, 9]);
});

test("a declared duration is rounded to the nearest whole Frame", () => {
  const durations = [
    { durationMs: 16, frames: 1 },
    { durationMs: 8, frames: 0 },
    { durationMs: 100, frames: 6 },
    { durationMs: 2850, frames: 171 },
  ];

  for (const { durationMs, frames } of durations) {
    const evaluated = evaluateTimeline({
      framerate: 60,
      startsAt: { scrollTop: 0 },
      segments: [{ kind: "hold", durationMs }],
    });

    assert.equal(evaluated.length, frames, `${durationMs}ms at 60fps`);
  }
});

test("a rounded-away segment still moves the Timeline on to its destination", () => {
  const frames = evaluateTimeline({
    framerate: 10,
    startsAt: { scrollTop: 0 },
    // 40ms at 10fps rounds to no Frames at all.
    segments: [
      { kind: "scroll-to", scrollTop: 300, durationMs: 40, easing: "linear" },
      { kind: "hold", durationMs: 200 },
    ],
  });

  assert.deepEqual(
    frames.map((frame) => frame.scrollTop),
    [300, 300],
  );
});

test("the scroll-peek shape is 171 Frames of travel down and back up", () => {
  const frames = evaluateTimeline({
    framerate: 60,
    startsAt: { scrollTop: 0 },
    segments: [
      { kind: "hold", durationMs: 400 },
      { kind: "scroll-to", scrollTop: 180, durationMs: 900, easing: "ease-in-out-cubic" },
      { kind: "hold", durationMs: 250 },
      { kind: "scroll-to", scrollTop: 0, durationMs: 900, easing: "ease-in-out-cubic" },
      { kind: "hold", durationMs: 400 },
    ],
  });

  // 2850ms at 60fps.
  assert.equal(frames.length, 171);
  assert.deepEqual(frames.at(0), { scrollTop: 0 });
  assert.deepEqual(frames.at(-1), { scrollTop: 0 });
  assert.equal(Math.max(...frames.map((frame) => frame.scrollTop)), 180);
});
