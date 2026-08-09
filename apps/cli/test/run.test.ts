/**
 * Recording, asserted at the CLI seam against the fixture site.
 *
 * The premise the whole design rests on is that two Runs of an unchanged Action
 * against an unchanged Project are identical, so that is the test that matters
 * here. It is asserted on hashes of the Frames rather than on the Frames
 * themselves, which is also all that survives a Run.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { RunReport } from "@record/core";

import { actionIn, record, removeWorkspaces, workspaceWith } from "./harness.js";

const execute = promisify(execFile);

/**
 * Small on purpose. Every Frame is a screenshot and an encode, so a test Action
 * asserts the same behaviour as a real one at a fraction of the wall-clock.
 */
const peek = `
import type { Action } from "@record/core";

const parameters = {
  distance: { kind: "number", describes: "how far the page travels", default: 200, min: 0, max: 2000 },
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ distance, framerate }) {
    return {
      framerate,
      startsAt: { scrollTop: 0 },
      segments: [
        { kind: "hold", durationMs: 100 },
        { kind: "scroll-to", scrollTop: distance, durationMs: 400, easing: "ease-in-out-cubic" },
        { kind: "hold", durationMs: 100 },
      ],
    };
  },
};

export default peek;
`;

// 100ms + 400ms + 100ms at 20fps.
const expectedFrames = 12;
const expectedFramerate = 20;

let site: FixtureSite;
let workspace: string;

/**
 * The two Runs every test here reads. Recording is slow enough that repeating
 * it per test would be felt, and the pair is what the determinism assertion
 * needs anyway.
 */
let first: RunReport;
let second: RunReport;

before(async () => {
  site = await startFixtureSite();
  workspace = await workspaceWith({
    demo: [
      `base_url = "${site.url}"`,
      `source_repository = "."`,
      "video_width = 320",
      "",
      "[viewport]",
      "width = 400",
      "height = 300",
      "device_scale_factor = 1",
      "",
    ].join("\n"),
  });
  await actionIn(workspace, "demo", "peek", peek);

  first = await recordPeek();
  second = await recordPeek();
});

after(async () => {
  await site.close();
  await removeWorkspaces();
});

async function recordPeek(): Promise<RunReport> {
  const { stdout, stderr, code } = await record(workspace, "run", "demo", "peek", "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as RunReport;
}

test("a Run writes an MP4 at the size, framerate and duration that were asked for", async () => {
  const [artifact, ...rest] = first.artifacts;

  assert.deepEqual(rest, [], "one Artifact format, for now");
  assert.equal(artifact?.format, "mp4");
  assert.equal(first.frames.captured, expectedFrames);
  assert.equal(first.framerate, expectedFramerate);

  // 320 wide keeps the viewport's 4:3 shape, and H.264 needs both even.
  assert.equal(artifact?.width, 320);
  assert.equal(artifact?.height, 240);
  assert.equal(artifact?.durationMs, 600);

  const encoded = await probe(artifact?.path ?? "");

  assert.equal(encoded.width, 320);
  assert.equal(encoded.height, 240);
  assert.equal(encoded.framerate, "20/1");
  assert.equal(encoded.frames, expectedFrames);
  assert.ok(
    Math.abs(encoded.durationMs - 600) <= 50,
    `expected roughly 600ms of video, got ${encoded.durationMs}ms`,
  );
});

test("captured Frames are deleted once encoding succeeds", async () => {
  const produced = join(workspace, "runs", "demo", "peek");

  // The Artifact, and nothing else -- no Frames, and no half-written encode.
  assert.deepEqual(await readdir(produced), ["peek.mp4"]);
});

/**
 * A Frame the compositor reports as undamaged returns no image, and is kept as
 * a repeat of the Frame before it rather than dropped -- a still moment is
 * still a Frame of video. Whether this fixture provokes that report is the
 * compositor's business; what a Run must guarantee is that the Frames it
 * captured are exactly the Frames the Timeline declared, and that the still
 * ones are still.
 */
test("a Run captures every Frame its Timeline declared, still ones included", () => {
  assert.equal(first.frames.hashes.length, expectedFrames);
  assert.equal(first.frames.captured, expectedFrames);

  // The Holds at either end do not move the page.
  assert.equal(first.frames.hashes.at(0), first.frames.hashes.at(1));
  assert.equal(first.frames.hashes.at(-1), first.frames.hashes.at(-2));

  // ...and the page did move in between, or this Action recorded nothing.
  assert.ok(new Set(first.frames.hashes).size > 2, "the page never moved");
});

/**
 * The premise ADR 0001 rests on. If this fails the design is wrong rather than
 * the test.
 *
 * No hash literal is committed: one would pin the assertion to the exact
 * Chromium build in TOOLING.md and to this machine's font rendering, so it
 * would fail on every upgrade for reasons that are not regressions. Comparing
 * two Runs catches what a golden would, without the false alarms.
 */
test("the same Action run twice against the same Project produces identical Frames", () => {
  assert.deepEqual(second.frames.hashes, first.frames.hashes);

  // Named so that a partial divergence names the Frame it began at.
  for (const frame of [0, Math.floor(expectedFrames / 2), expectedFrames - 1]) {
    assert.equal(second.frames.hashes[frame], first.frames.hashes[frame], `Frame ${frame}`);
  }

  assert.equal(second.frames.repeated, first.frames.repeated);
});

/**
 * If the count of Frames driven before capture began varied between Runs, so
 * would every Frame after it. Two priming Frames is what the clock spike
 * measured against the Chromium pinned in TOOLING.md, on every run it ever
 * made; the engine drives exactly that many and fails rather than capture a
 * page that has not painted.
 */
test("the Frames driven before capture are a fixed count, not whatever the machine needed", () => {
  assert.deepEqual(first.frames.priming, { compositor: 2, settle: 60 });
  assert.deepEqual(second.frames.priming, first.frames.priming);
});

test("`run` without an Action to run says so rather than recording something else", async () => {
  const { stderr, code } = await record(workspace, "run", "demo");

  assert.equal(code, 1);
  assert.match(stderr, /run takes the name of one Project and one of its Actions/);
});

test("naming an Action the Project does not declare fails with a message saying so", async () => {
  const { stderr, code } = await record(workspace, "run", "demo", "nothing-like-it");

  assert.equal(code, 1);
  assert.match(stderr, /no Action named 'nothing-like-it' is declared by Project 'demo'/);
});

type Probed = {
  readonly width: number;
  readonly height: number;
  readonly framerate: string;
  readonly frames: number;
  readonly durationMs: number;
};

/** What ffprobe says the encoded Artifact actually is, rather than what we meant it to be. */
async function probe(file: string): Promise<Probed> {
  const { stdout } = await execute("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate,nb_frames",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ]);

  const probed = JSON.parse(stdout) as {
    streams?: { width: number; height: number; r_frame_rate: string; nb_frames: string }[];
    format?: { duration: string };
  };
  const stream = probed.streams?.[0];
  assert.ok(stream !== undefined, `ffprobe found no video stream in ${file}`);

  return {
    width: stream.width,
    height: stream.height,
    framerate: stream.r_frame_rate,
    frames: Number(stream.nb_frames),
    durationMs: Math.round(Number(probed.format?.duration ?? 0) * 1000),
  };
}
