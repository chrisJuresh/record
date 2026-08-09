import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateTimeline } from "../src/timeline.js";

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
