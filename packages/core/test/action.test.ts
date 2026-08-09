/**
 * The Timeline evaluation seam, from the end an Action sees it: a pure function
 * from an Action and its effective Parameters to a per-Frame list of page
 * states, with no browser anywhere near it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { effectiveParameters, type Action } from "../src/action.js";
import { RecordError } from "../src/errors.js";
import { evaluateTimeline } from "../src/timeline.js";

const parameters = {
  distance: {
    kind: "number",
    describes: "How far down the page travels, in CSS pixels",
    default: 100,
    min: 0,
    max: 1000,
  },
  travel: {
    kind: "number",
    describes: "How long the travel takes, in milliseconds",
    default: 500,
    min: 100,
    max: 5000,
  },
  framerate: { kind: "number", describes: "Frames per second", default: 10, min: 1, max: 120 },
  easing: { kind: "easing", describes: "How the travel settles", default: "linear" },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ distance, travel, framerate, easing }) {
    return {
      framerate,
      startsAt: { scrollTop: 0 },
      segments: [
        { kind: "hold", durationMs: 200 },
        { kind: "scroll-to", scrollTop: distance, durationMs: travel, easing },
      ],
    };
  },
};

test("an Action and its effective Parameters decide every Frame's page state", () => {
  const frames = evaluateTimeline(peek.timeline(effectiveParameters(peek.parameters)));

  // 200ms of Hold then 500ms of travel, at 10fps.
  assert.deepEqual(
    frames.map((frame) => frame.scrollTop),
    [0, 0, 0, 20, 40, 60, 80],
  );
});

test("the effective Parameters are what the Action declares, under the names it declared them", () => {
  assert.deepEqual(effectiveParameters(peek.parameters), {
    distance: 100,
    travel: 500,
    framerate: 10,
    easing: "linear",
  });
});

test("a Parameter defaulting outside its own range fails naming the Parameter", () => {
  assert.throws(
    () =>
      effectiveParameters({
        distance: { kind: "number", describes: "How far", default: 4000, min: 0, max: 1000 },
      }),
    (failure: Error) => {
      assert.ok(failure instanceof RecordError);
      assert.match(failure.message, /'distance' defaults to 4000, outside its own range 0\.\.1000/);
      return true;
    },
  );
});
