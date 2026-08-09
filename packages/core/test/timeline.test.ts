/**
 * The Timeline evaluation seam. Easings, Hold boundaries, duration rounding and
 * what each motion primitive does to a Frame are asserted here rather than
 * through a browser, because a Chromium launch per easing is how such
 * assertions stop being run.
 *
 * Timelines are written the way an Action writes them, over the primitives, so
 * that what is asserted is what an Action can actually say.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { RecordError } from "../src/errors.js";
import type { Key } from "../src/keys.js";
import { motion } from "../src/motion.js";
import { evaluateTimeline, type EasingName, type PageState, type Timeline } from "../src/timeline.js";

/** The scroll position of every Frame a single travelling segment produces. */
function travel(easing: EasingName, distance: number, frames: number): number[] {
  return scrolls(motion({ framerate: 10 }).scrollTo(distance, { durationMs: frames * 100, easing }));
}

function scrolls(timeline: Timeline): number[] {
  return evaluateTimeline(timeline).map((frame) => frame.scrollTop);
}

/** The cursor starts somewhere for the Actions that move it, and nowhere for the rest. */
const fromTopLeft = { scrollTop: 0, cursor: { x: 0, y: 0 } };

test("a Hold occupies one Frame per frame interval and nothing moves", () => {
  const frames = evaluateTimeline(motion({ framerate: 60 }).hold(400));

  // 0.4s at 60fps.
  assert.equal(frames.length, 24);
  assert.deepEqual([...new Set(frames.map((frame) => frame.scrollTop))], [0]);
});

test("a Frame of an Action that never moves a cursor has none, and does nothing to the page", () => {
  const [frame] = evaluateTimeline(motion({ framerate: 10 }).hold(100));

  assert.deepEqual(frame, { scrollTop: 0, cursor: null, does: [] });
});

test("consecutive Holds run one after the other from where the Timeline starts", () => {
  const frames = evaluateTimeline(
    motion({ framerate: 30, startsAt: { scrollTop: 180 } }).hold(400).hold(250),
  );

  // 0.4s and 0.25s at 30fps: 12 Frames then 8 (7.5 rounded).
  assert.equal(frames.length, 20);
  assert.equal(frames.at(0)?.scrollTop, 180);
  assert.equal(frames.at(-1)?.scrollTop, 180);
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

test("travel eases at both ends unless the Action asks for something else", () => {
  assert.deepEqual(
    scrolls(motion({ framerate: 10 }).scrollTo(1000, { durationMs: 1000 })),
    travel("ease-in-out-cubic", 1000, 10),
  );
});

/**
 * The travelling segment stops one step short of its destination, and the Hold
 * after it sits on the destination itself -- so a Hold is a still image rather
 * than a frame of leftover motion.
 */
test("a Hold after a scroll holds at the destination, not at the last moving Frame", () => {
  const frames = motion({ framerate: 10 })
    .scrollTo(100, { durationMs: 500, easing: "linear" })
    .hold(300);

  assert.deepEqual(scrolls(frames), [0, 20, 40, 60, 80, 100, 100, 100]);
});

test("a scroll starts from wherever the Timeline has reached, in either direction", () => {
  const frames = motion({ framerate: 10 })
    .scrollTo(200, { durationMs: 200, easing: "linear" })
    .scrollTo(0, { durationMs: 200, easing: "linear" });

  assert.deepEqual(scrolls(frames), [0, 100, 200, 100]);
});

test("scrolling by a distance travels that far from where the Timeline has reached", () => {
  const frames = motion({ framerate: 10, startsAt: { scrollTop: 50 } })
    .scrollBy(100, { durationMs: 200, easing: "linear" })
    .scrollBy(-50, { durationMs: 200, easing: "linear" })
    .hold(100);

  assert.deepEqual(scrolls(frames), [50, 100, 150, 125, 100]);
});

/**
 * Chromium rounds scrollTop to whole CSS pixels (ADR 0008), so an evaluated
 * page state carrying a fraction would describe a position the page cannot
 * occupy.
 */
test("a page state is a whole CSS pixel, because that is the finest the page can hold", () => {
  assert.deepEqual(travel("linear", 10, 8), [0, 1, 3, 4, 5, 6, 8, 9]);
});

test("a declared duration is rounded to the nearest whole Frame", () => {
  const durations = [
    { durationMs: 16, frames: 1 },
    { durationMs: 8, frames: 0 },
    { durationMs: 100, frames: 6 },
    { durationMs: 2850, frames: 171 },
  ];

  for (const { durationMs, frames } of durations) {
    assert.equal(
      evaluateTimeline(motion({ framerate: 60 }).hold(durationMs)).length,
      frames,
      `${durationMs}ms at 60fps`,
    );
  }
});

test("a rounded-away segment still moves the Timeline on to its destination", () => {
  // 40ms at 10fps rounds to no Frames at all.
  const frames = motion({ framerate: 10 })
    .scrollTo(300, { durationMs: 40, easing: "linear" })
    .hold(200);

  assert.deepEqual(scrolls(frames), [300, 300]);
});

test("the cursor travels across the viewport along its easing, in whole pixels", () => {
  const frames = evaluateTimeline(
    motion({ framerate: 10, startsAt: fromTopLeft })
      .moveCursorTo({ x: 100, y: 50 }, { durationMs: 500, easing: "linear" })
      .hold(100),
  );

  assert.deepEqual(
    frames.map((frame) => frame.cursor),
    [
      { x: 0, y: 0, pressed: false },
      { x: 20, y: 10, pressed: false },
      { x: 40, y: 20, pressed: false },
      { x: 60, y: 30, pressed: false },
      { x: 80, y: 40, pressed: false },
      { x: 100, y: 50, pressed: false },
    ],
  );
});

/**
 * There is no real pointer in a stepped headless browser, so no Action can be
 * asked where the cursor already is.
 */
test("moving a cursor the Action never placed fails saying so", () => {
  assert.throws(
    () => evaluateTimeline(motion({ framerate: 10 }).moveCursorTo({ x: 1, y: 1 }, { durationMs: 100 })),
    (failure: Error) => {
      assert.ok(failure instanceof RecordError);
      assert.match(failure.message, /must declare where the cursor starts/);
      return true;
    },
  );
});

test("a click holds the cursor down for its own span and lets go after it", () => {
  const frames = evaluateTimeline(
    motion({ framerate: 10, startsAt: { scrollTop: 0, cursor: { x: 5, y: 5 } } })
      .hold(100)
      .click({ durationMs: 200 })
      .hold(100),
  );

  assert.deepEqual(
    frames.map((frame) => ({ pressed: frame.cursor?.pressed, does: frame.does })),
    [
      { pressed: false, does: [] },
      { pressed: true, does: [{ kind: "cursor-press" }] },
      { pressed: true, does: [] },
      { pressed: false, does: [{ kind: "cursor-release" }] },
    ],
  );
});

test("a press is one whole keystroke, followed by a span for the page to answer it", () => {
  const frames = evaluateTimeline(
    motion({ framerate: 10 }).press("Enter", { durationMs: 200 }).hold(100),
  );

  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0]?.does, [
    { kind: "key", stroke: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" } },
  ]);
  assert.deepEqual(frames[1]?.does, []);
});

/**
 * A key an Action could name is a key `pnpm build` accepts, which is what ADR
 * 0004 chose TypeScript for. This is the backstop underneath that, for a name
 * that reached the engine from somewhere untyped.
 */
test("a key the browser has no name for fails before anything is recorded", () => {
  assert.throws(
    () => evaluateTimeline(motion({ framerate: 10 }).press("Enterr" as Key)),
    (failure: Error) => {
      assert.ok(failure instanceof RecordError);
      assert.match(failure.message, /'Enterr' is not a key that can be pressed/);
      return true;
    },
  );
});

/**
 * Typing arrives as keystrokes rather than as inserted text, because a page
 * that filters as you type or answers a shortcut listens for the key -- and
 * would record as though nothing had been typed.
 */
test("typing spends one span per character, and each character is a keystroke", () => {
  const frames = evaluateTimeline(motion({ framerate: 10 }).type("h!", { perKeyMs: 200 }));

  assert.deepEqual(
    frames.map((frame) => frame.does),
    [
      [{ kind: "key", stroke: { key: "h", code: "KeyH", keyCode: 72, text: "h" } }],
      [],
      [{ kind: "key", stroke: { key: "!", code: "", keyCode: 33, text: "!" } }],
      [],
    ],
  );
});

/**
 * A wait occupies the span it declared rather than however long the page took,
 * because a Frame count that depended on the page would make two Runs of the
 * same Action different lengths. What is left is whether the wait was long
 * enough, which is checked at the end of it.
 */
test("a wait is a Hold whose condition has to hold by the last Frame of it", () => {
  const frames = evaluateTimeline(
    motion({ framerate: 10 }).waitFor("window.ready", { durationMs: 300, describes: "the grid" }),
  );

  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0]?.does, []);
  assert.deepEqual(frames.at(-1)?.does, [
    { kind: "require", condition: "window.ready", describes: "the grid" },
  ]);
});

/**
 * The one rounding a Timeline must not do quietly. A wait is checked on the
 * last Frame of its own span, so a wait rounded away is a Run that passes
 * without ever having looked.
 */
test("a wait too short to occupy a Frame is refused rather than rounded away", () => {
  assert.throws(
    () =>
      evaluateTimeline(
        motion({ framerate: 10 }).waitFor("window.ready", { durationMs: 40, describes: "the grid" }),
      ),
    (failure: Error) => {
      assert.ok(failure instanceof RecordError);
      assert.match(failure.message, /waiting for the grid was given 40ms, which is less than one Frame/);
      return true;
    },
  );
});

test("the escape hatch takes no time and lands on the next Frame drawn", () => {
  const frames = evaluateTimeline(
    motion({ framerate: 10 }).evaluate("document.body.classList.add('dark')").hold(200),
  );

  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0]?.does, [
    { kind: "evaluate", expression: "document.body.classList.add('dark')" },
  ]);
  assert.deepEqual(frames[1]?.does, []);
});

test("what an Action does after its last Frame is dropped, because no Frame shows it", () => {
  const frames = evaluateTimeline(
    motion({ framerate: 10, startsAt: { scrollTop: 0, cursor: { x: 5, y: 5 } } }).click({
      durationMs: 100,
    }),
  );

  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]?.does, [{ kind: "cursor-press" }]);
});

test("the scroll-peek shape is 171 Frames of travel down and back up", () => {
  const frames = evaluateTimeline(
    motion({ framerate: 60 })
      .hold(400)
      .scrollTo(180, { durationMs: 900, easing: "ease-in-out-cubic" })
      .hold(250)
      .scrollTo(0, { durationMs: 900, easing: "ease-in-out-cubic" })
      .hold(400),
  );

  // 2850ms at 60fps.
  assert.equal(frames.length, 171);
  assert.equal(frames.at(0)?.scrollTop, 0);
  assert.equal(frames.at(-1)?.scrollTop, 0);
  assert.equal(Math.max(...frames.map((frame) => frame.scrollTop)), 180);
});

/**
 * The primitives name the segments an Action would otherwise have written by
 * hand, and nothing more: the Frames either form produces are the same ones.
 * This is what lets an Action be rewritten over the primitives without its
 * clip changing.
 */
test("an Action written over the primitives evaluates to the Frames its segments would", () => {
  const written: PageState[] = evaluateTimeline(
    motion({ framerate: 60 })
      .hold(400)
      .scrollTo(180, { durationMs: 900, easing: "ease-in-out-cubic" })
      .hold(400),
  );

  const spelled = evaluateTimeline({
    framerate: 60,
    startsAt: { scrollTop: 0 },
    segments: [
      { kind: "hold", durationMs: 400 },
      { kind: "scroll-to", scrollTop: 180, durationMs: 900, easing: "ease-in-out-cubic" },
      { kind: "hold", durationMs: 400 },
    ],
  });

  assert.deepEqual(written, spelled);
});
