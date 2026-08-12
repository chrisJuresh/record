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
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { Artifact, ArtifactFormat, RunReport } from "@record/core";

import { actionIn, artifactsOf, record, removeWorkspaces, workspaceWith } from "./harness.js";

const execute = promisify(execFile);

/**
 * Small on purpose. Every Frame is a screenshot and an encode, so a test Action
 * asserts the same behaviour as a real one at a fraction of the wall-clock.
 */
const peek = `
import { motion, type Action } from "@record/core";

const parameters = {
  distance: { kind: "number", describes: "how far the page travels", default: 200, min: 0, max: 2000 },
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ distance, framerate }) {
    return motion({ framerate })
      .hold(100)
      .scrollTo(distance, { durationMs: 400, easing: "ease-in-out-cubic" })
      .hold(100);
  },
};

export default peek;
`;

// 100ms + 400ms + 100ms at 20fps.
const expectedFrames = 12;
const expectedFramerate = 20;

/** The viewport both Projects are photographed at, in CSS pixels. */
const viewport = { width: 400, height: 300 };

/** The three ADR 0006 requires, in the order a Run reports them. */
const expectedFormats: ArtifactFormat[] = ["mp4", "webm", "gif"];

let site: FixtureSite;
let workspace: string;

/**
 * The Runs every test here reads. Recording is slow enough that repeating it
 * per test would be felt, and the pair of identical Runs is what the
 * determinism assertion needs anyway. The third is the same Action tuned by
 * hand, which is only worth a recording because what it proves is that the
 * tuned values reached the browser and the encoder.
 */
let first: RunReport;
let second: RunReport;
let tuned: RunReport;
let sharp: RunReport;

before(async () => {
  site = await startFixtureSite();
  workspace = await workspaceWith({
    demo: project(site.url, 1, 320),
    // The same page photographed at twice the density, and encoded wider than
    // it is in CSS pixels -- which is the only arrangement that has anything to
    // gain from a scale factor.
    sharp: project(site.url, 2, 640),
  });
  await actionIn(workspace, "demo", "peek", peek);
  // The same Action under a second name. A Run writes over the Artifacts of the
  // last Run of that Action, so the tuned Run needs somewhere of its own for
  // both its Artifacts and the untuned ones to still be there to measure.
  await actionIn(workspace, "demo", "tight", peek);
  await actionIn(workspace, "sharp", "peek", peek);

  first = await recordRun("peek");
  second = await recordRun("peek");
  tuned = await recordRun("tight", "--set", "distance=40", "--set", "gifWidth=160", "--set", "gifFramerate=10");
  sharp = await recordIn("sharp", "peek");
});

/** A Project on the fixture site, photographed at a density and encoded at a width. */
function project(baseUrl: string, scale: number, videoWidth: number): string {
  return [
    `base_url = "${baseUrl}"`,
    `source_repository = "."`,
    `video_width = ${videoWidth}`,
    'mockup = "none"',
    "",
    "[viewport]",
    `width = ${viewport.width}`,
    `height = ${viewport.height}`,
    `device_scale_factor = ${scale}`,
    "",
  ].join("\n");
}

after(async () => {
  await site.close();
  await removeWorkspaces();
});

async function recordRun(action: string, ...args: string[]): Promise<RunReport> {
  return recordIn("demo", action, ...args);
}

async function recordIn(project: string, action: string, ...args: string[]): Promise<RunReport> {
  const { stdout, stderr, code } = await record(workspace, "run", project, action, ...args, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as RunReport;
}

/**
 * Three Artifacts from the Frames of one Run, because the delivery targets
 * differ (ADR 0006): a GIF is the only one that plays inline in a README, and a
 * web page wants a video element with WebM for size and MP4 as its fallback.
 */
test("a Run encodes an MP4, a WebM and a GIF from the Frames it captured once", () => {
  assert.deepEqual(
    first.artifacts.map((artifact) => artifact.format),
    expectedFormats,
  );
  assert.equal(first.frames.captured, expectedFrames);
  assert.equal(first.framerate, expectedFramerate);
});

test("the video Artifacts keep the captured framerate and the Project's video width", async () => {
  for (const format of ["mp4", "webm"] as const) {
    const artifact = artifactOf(first, format);

    // 320 wide keeps the viewport's 4:3 shape, and H.264 needs both even.
    assert.equal(artifact.width, 320, format);
    assert.equal(artifact.height, 240, format);
    assert.equal(artifact.framerate, expectedFramerate, format);
    assert.equal(artifact.durationMs, 600, format);

    const encoded = await probe(artifact.path);

    assert.equal(encoded.width, 320, format);
    assert.equal(encoded.height, 240, format);
    assert.equal(encoded.framerate, "20/1", format);
    assert.equal(encoded.frames, expectedFrames, format);
    assert.ok(
      Math.abs(encoded.durationMs - 600) <= 50,
      `expected roughly 600ms of ${format}, got ${encoded.durationMs}ms`,
    );
  }
});

/**
 * The GIF's declared width of 640 is wider than this deliberately tiny fixture
 * ever captured, which is beside the point: what is asserted is that the
 * declared Parameters are what reached the encoder rather than a constant.
 */
test("the GIF is encoded at the width and framerate its Parameters declare", async () => {
  const artifact = artifactOf(first, "gif");

  assert.equal(artifact.width, 640);
  assert.equal(artifact.height, 480);
  assert.equal(artifact.framerate, 20);
  assert.equal(artifact.durationMs, 600);

  const encoded = await probe(artifact.path);

  assert.equal(encoded.width, 640);
  assert.equal(encoded.height, 480);
  assert.equal(encoded.framerate, "20/1");
  assert.equal(encoded.frames, expectedFrames);
  assert.ok(
    Math.abs(encoded.durationMs - 600) <= 50,
    `expected roughly 600ms of GIF, got ${encoded.durationMs}ms`,
  );
});

/**
 * 256 colours taken from the clip rather than 256 fixed ones, which is the
 * difference between a GIF worth putting in a README and one that is not.
 *
 * Both Artifacts were encoded from the same Frames, so the colour most of the
 * page is has to survive into both. A fixed palette could not hold it: asked to
 * encode a GIF without one being generated, ffmpeg crushes this fixture's
 * near-black background to black.
 */
test("the GIF's colours are a palette taken from the clip, not a fixed one", async () => {
  const inGif = await dominantColour(artifactOf(first, "gif").path);
  const inVideo = await dominantColour(artifactOf(first, "mp4").path);

  for (const channel of [0, 1, 2] as const) {
    assert.ok(
      Math.abs(inGif[channel] - inVideo[channel]) <= 8,
      `channel ${channel} of ${inGif.join()} is nothing like ${inVideo.join()}`,
    );
  }
});

/**
 * The GIF is the Artifact that balloons and the one most likely to be seen, so
 * its two size levers are Parameters rather than constants. Tuning them changes
 * the encoded file and nothing else: the same span of time, fewer and smaller
 * Frames of it.
 */
test("tuning the GIF's Parameters shrinks the GIF and leaves the video Artifacts alone", async () => {
  const gif = await probe(artifactOf(tuned, "gif").path);

  assert.equal(gif.width, 160);
  assert.equal(gif.height, 120);
  assert.equal(gif.framerate, "10/1");
  assert.equal(gif.frames, expectedFrames / 2, "half the framerate over the same duration");
  assert.ok(Math.abs(gif.durationMs - 600) <= 50, `expected roughly 600ms of GIF, got ${gif.durationMs}ms`);

  const mp4 = await probe(artifactOf(tuned, "mp4").path);

  assert.equal(mp4.width, 320);
  assert.equal(mp4.framerate, "20/1");
  assert.equal(mp4.frames, expectedFrames);
});

test("captured Frames are deleted once encoding succeeds", async () => {
  // The Artifacts, their snippet and the Run's own record, and nothing else --
  // no Frames, and no half-written encode.
  assert.deepEqual((await readdir(first.directory)).sort(), [
    "peek.embed.html",
    "peek.gif",
    "peek.mp4",
    "peek.webm",
    "run.json",
  ]);
});

/**
 * Putting a clip on a page should never require remembering a video element's
 * attributes, so the Run writes the element it wrote the Artifacts for. Its
 * sources are named relative to itself, so the folder can be copied anywhere.
 */
test("an embed snippet naming both video sources is written beside the Artifacts", async () => {
  const snippet = await readFile(first.embed, "utf8");

  assert.equal(first.embed, join(first.directory, "peek.embed.html"));
  assert.match(snippet, /<source src="peek\.webm" type="video\/webm"/);
  assert.match(snippet, /<source src="peek\.mp4" type="video\/mp4"/);
  assert.ok(
    snippet.indexOf("peek.webm") < snippet.indexOf("peek.mp4"),
    "WebM is offered before the MP4 fallback",
  );
  assert.match(snippet, /<video[^>]*\bloop\b/, "a clip this short is meant to loop");
  assert.doesNotMatch(snippet, /runs[\\/]/, "no path from this machine leaks into the snippet");
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
 * ...and the Artifacts encoded from those Frames are the same bytes, not merely
 * the same clip. Encoding is bit-exact for this: a container that stamped in
 * the moment it was written would make every re-recording of an unchanged
 * Action look like a change.
 */
test("two Runs of an unchanged Action encode identical Artifacts", async () => {
  const one = await artifactsOf(first);
  const other = await artifactsOf(second);

  assert.deepEqual(other, one);
  assert.equal(Object.keys(one).length, 4, "the three Artifacts and the embed snippet");
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

test("a Run reports the Parameter values it ran with, the Artifacts' included", () => {
  assert.deepEqual(first.parameters, {
    distance: 200,
    framerate: 20,
    cursor: "auto",
    cursorStyle: "soft-dot",
    cursorCaptions: false,
    mockup: "none",
    gifWidth: 640,
    gifFramerate: 20,
  });

  // An Action that only travels draws no cursor, so this clip is the page and
  // nothing else.
  assert.deepEqual(first.cursor, { shown: false, style: "soft-dot", captions: false });
  // ...and a Run that composited nothing reports no surround, rather than an
  // empty one it passed its Frames through.
  assert.deepEqual(first.mockup, {
    asked: "none",
    name: "none",
    colourScheme: "dark",
    surround: null,
  });
  assert.deepEqual(first.overridden, []);
  assert.deepEqual(first.warnings, []);
});

/**
 * The whole point of an Override: the value reaches the browser, and it is
 * still there next time. Asserted through a real recording because a tuned
 * value that never left the report would be no tuning at all.
 */
test("`run --set` records with the Override and keeps it in the sidecar", async () => {
  assert.deepEqual(tuned.overridden, ["distance", "gifWidth", "gifFramerate"]);
  assert.equal(tuned.parameters["distance"], 40);

  // Same Timeline, same Frames -- a shorter travel, not a shorter clip.
  assert.equal(tuned.frames.captured, expectedFrames);
  assert.notDeepEqual(tuned.frames.hashes, first.frames.hashes);

  const sidecar = join(workspace, "projects", "demo", "actions", "tight.overrides.toml");
  assert.match(await readFile(sidecar, "utf8"), /distance = 40/);
});

/**
 * `viewport.device_scale_factor` used to be a Setting the engine ignored: it
 * reached `Emulation.setDeviceMetricsOverride`, which moves what the page
 * believes its own `devicePixelRatio` is and never the size of the image
 * `beginFrame` hands back, so a Project at scale 2 was photographed at CSS
 * pixels exactly like one at scale 1 (`spikes/device-scale/`).
 *
 * Held at both scales rather than at 2 alone, because "the Frames are 800x600"
 * proves nothing about the Setting unless the Frames of the same page at scale
 * 1 are not.
 */
test("a Project photographed at scale 2 captures Frames at twice its CSS viewport", () => {
  assert.deepEqual(
    { width: first.frames.width, height: first.frames.height, scale: first.frames.scale },
    { ...viewport, scale: 1 },
    "at scale 1 a Frame is the viewport",
  );

  assert.deepEqual(
    { width: sharp.frames.width, height: sharp.frames.height, scale: sharp.frames.scale },
    { width: viewport.width * 2, height: viewport.height * 2, scale: 2 },
    "at scale 2 it is twice the viewport in each direction",
  );
});

/**
 * The scale a Run reports is measured off its own Frames rather than copied
 * from what the Project asked for. The distinction is the whole of this issue:
 * the Setting said 2 for as long as the engine captured at 1, and a record
 * repeating the Setting back would have said 2 that whole time.
 *
 * So it is held against the Frames, and said in the command's own words at both
 * scales -- a Run at 1 says its size plainly, and one at 2 says what it is.
 */
test("the scale a Run reports is measured off its Frames, and said in its own words", async () => {
  assert.equal(sharp.frames.scale, sharp.frames.width / viewport.width);
  assert.equal(first.frames.scale, first.frames.width / viewport.width);

  const { stdout, code } = await record(workspace, "status");
  assert.equal(code, 0);

  assert.match(stdout, /800x600 at scale 2/, "the Project photographed at twice the density");
  assert.match(stdout, /400x300(?! at scale)/, "and the one at 1, which says no scale at all");
});

/**
 * What the scale factor is *for*. A clip embedded on a page and shown on a
 * high-density display needs more pixels than it has CSS pixels, so the width
 * that matters is one above the viewport's own -- and at scale 1 that width
 * could only ever be reached by upsampling Frames that never held the detail.
 *
 * Asserted against the encoded file rather than the report: the Artifact is the
 * thing that has to carry the pixels.
 */
test("a Run encodes above its CSS viewport width from Frames that really are that wide", async () => {
  const encoded = await probe(artifactOf(sharp, "mp4").path);

  assert.equal(encoded.width, 640, "encoded at the Project's video width");
  assert.equal(encoded.height, 480);

  assert.ok(
    sharp.frames.width >= encoded.width,
    `640 pixels of Artifact came from ${sharp.frames.width} pixels of Frame, so nothing was invented`,
  );
  assert.ok(
    encoded.width > viewport.width,
    "the width worth having is one the CSS viewport could not supply on its own",
  );
});

test("naming an Action the Project does not declare fails with a message saying so", async () => {
  const { stderr, code } = await record(workspace, "run", "demo", "nothing-like-it");

  assert.equal(code, 1);
  assert.match(stderr, /no Action named 'nothing-like-it' is declared by Project 'demo'/);
});

/**
 * The colour most of an Artifact's first Frame is, as ffmpeg decodes it. Which
 * colour that is belongs to the fixture site; that two Artifacts of one Run
 * agree on it is what a test can ask.
 */
async function dominantColour(file: string): Promise<readonly [number, number, number]> {
  const { stdout } = await execute(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );

  const counts = new Map<number, number>();
  for (let at = 0; at + 2 < stdout.length; at += 3) {
    const colour = ((stdout[at] ?? 0) << 16) | ((stdout[at + 1] ?? 0) << 8) | (stdout[at + 2] ?? 0);
    counts.set(colour, (counts.get(colour) ?? 0) + 1);
  }

  const [dominant = 0] = [...counts].sort(([, one], [, other]) => other - one)[0] ?? [];

  return [(dominant >> 16) & 0xff, (dominant >> 8) & 0xff, dominant & 0xff];
}

/** The Artifact of one format a Run reported, or a failure naming the format that is missing. */
function artifactOf(report: RunReport, format: ArtifactFormat): Artifact {
  const artifact = report.artifacts.find((candidate) => candidate.format === format);
  assert.ok(artifact !== undefined, `the Run reported no ${format}`);
  return artifact;
}

type Probed = {
  readonly width: number;
  readonly height: number;
  readonly framerate: string;
  readonly frames: number;
  readonly durationMs: number;
};

/**
 * What ffprobe says the encoded Artifact actually is, rather than what we meant
 * it to be. The Frames are counted rather than read off the container, because
 * WebM does not record a count to read.
 */
async function probe(file: string): Promise<Probed> {
  const { stdout } = await execute("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=width,height,r_frame_rate,nb_read_frames",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ]);

  const probed = JSON.parse(stdout) as {
    streams?: { width: number; height: number; r_frame_rate: string; nb_read_frames: string }[];
    format?: { duration: string };
  };
  const stream = probed.streams?.[0];
  assert.ok(stream !== undefined, `ffprobe found no video stream in ${file}`);

  return {
    width: stream.width,
    height: stream.height,
    framerate: stream.r_frame_rate,
    frames: Number(stream.nb_read_frames),
    durationMs: Math.round(Number(probed.format?.duration ?? 0) * 1000),
  };
}
