/**
 * Mockups, asserted at the CLI seam against the fixture site.
 *
 * A surround is only worth anything if it is in the Artifact, so every
 * assertion here is made against what was actually encoded: the shape ffprobe
 * says the file is, and the bytes two Runs of one Action left behind.
 *
 * The one thing that cannot be asserted is whether a surround looks right,
 * which is what the contact sheet is for -- so what is asserted about it is
 * that every preset that ships came out of the same code path.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { after, before, test } from "node:test";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { ContactSheetReport, RunReport } from "@record/core";

import {
  actionIn,
  artifactsOf,
  probeSize,
  projectIn,
  record,
  removeWorkspaces,
  workspaceWith,
} from "./harness.js";

/** Small on purpose: every Frame is a screenshot, an encode and a composite. */
const peek = `
import { motion, type Action } from "@record/core";

const peek: Action<{}> = {
  parameters: {},
  timeline() {
    return motion({ framerate: 10 }).hold(200);
  },
};

export default peek;
`;

/** The captured Frames of this Project, before anything is composited around them. */
const captured = { width: 400, height: 300 };

/** What an Artifact of those Frames is encoded at, undecorated. */
const bareSize = { width: 320, height: 240 };

let site: FixtureSite;
let workspace: string;

/**
 * One Run per thing worth knowing, recorded once and read by every test.
 * Recording is slow enough that repeating it per test would be felt, and the
 * pair of Runs of one Action is what the determinism assertion needs anyway.
 */
let inWindow: RunReport;
let again: RunReport;
let bare: RunReport;
let overridden: RunReport;
let onDark: RunReport;
let onLight: RunReport;

before(async () => {
  site = await startFixtureSite();

  workspace = await workspaceWith({
    // Says which surround it wants, so that what its Actions carry is its
    // choice rather than a constant.
    demo: project(site.url, 'mockup = "browser-light"'),
    // Says nothing, which is the page's cue to choose. The fixture site paints
    // itself nearly black; the same site in light is a page of its own.
    dark: project(site.url),
    light: project(`${site.url}light.html`),
  });

  for (const [name, action] of [
    ["demo", "peek"],
    ["demo", "bare"],
    ["demo", "elsewhere"],
    ["dark", "peek"],
    ["light", "peek"],
  ] as const) {
    await actionIn(workspace, name, action, peek);
  }

  inWindow = await recordRun("demo", "peek");
  again = await recordRun("demo", "peek");
  bare = await recordRun("demo", "bare", "--set", "mockup=none");
  overridden = await recordRun("demo", "elsewhere", "--set", "mockup=rounded");
  onDark = await recordRun("dark", "peek");
  onLight = await recordRun("light", "peek");
});

after(async () => {
  await site.close();
  await removeWorkspaces();
});

/** A Project pointed at a page of the fixture site, tiny and never started. */
function project(baseUrl: string, ...lines: string[]): string {
  return [
    `base_url = "${baseUrl}"`,
    `source_repository = "."`,
    "video_width = 320",
    ...lines,
    "",
    "[viewport]",
    `width = ${captured.width}`,
    `height = ${captured.height}`,
    "device_scale_factor = 1",
    "",
  ].join("\n");
}

async function recordRun(project: string, action: string, ...args: string[]): Promise<RunReport> {
  const { stdout, stderr, code } = await record(workspace, "run", project, action, ...args, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as RunReport;
}

/**
 * What a Mockup is for: the clip arrives inside a surround. The Frames are the
 * Frames either way -- what changed is the shape of what was encoded from them,
 * and the Artifact is still as wide as it was asked to be, so a Mockup costs
 * room inside the clip rather than around it.
 */
test("a Mockup is composited around the Frames, and the Artifact keeps its declared width", async () => {
  assert.equal(inWindow.mockup.name, "browser-light");
  assert.deepEqual(inWindow.frames.hashes, bare.frames.hashes, "the same Frames were captured");

  const mp4 = await probeSize(artifact(inWindow, "mp4"));

  assert.equal(mp4.width, bareSize.width, "as wide as the Project asked for");
  assert.ok(
    mp4.height > bareSize.height,
    `a titlebar and a margin make the clip taller than ${bareSize.height}, got ${mp4.height}`,
  );

  // ...and the Run that composited nothing is exactly the Artifact it always was.
  assert.deepEqual(await probeSize(artifact(bare, "mp4")), bareSize);
  assert.equal(bare.mockup.name, "none");
});

/**
 * A Mockup is chosen for a Project and overridden for the one Action that wants
 * a different one, which is the same shape as every other Parameter: the
 * Project's choice is the declared default, and the sidecar wins over it.
 */
test("a Mockup is selected per Project and overridden per Action", async () => {
  assert.equal(inWindow.parameters["mockup"], "browser-light", "the Project's choice");
  assert.equal(overridden.mockup.name, "rounded");
  assert.deepEqual(overridden.overridden, ["mockup"]);

  // Rounded corners cost nothing but a margin, and a window costs a titlebar,
  // so the two surrounds are not the same surround.
  const rounded = await probeSize(artifact(overridden, "mp4"));
  const window = await probeSize(artifact(inWindow, "mp4"));

  assert.ok(rounded.height > bareSize.height, "rounded still leaves room for its shadow");
  assert.notDeepEqual(rounded, window);
});

/**
 * The default for a Project that never chose: the page is asked how it reads,
 * and gets the window that suits it. The fixture site paints itself nearly
 * black and the same site in light does not, so one Project of each is the
 * whole of the choice.
 */
test("a Project that chose no Mockup gets the window its page reads as", () => {
  assert.deepEqual(onDark.mockup, {
    asked: "auto",
    name: "browser-dark",
    colourScheme: "dark",
  });
  assert.deepEqual(onLight.mockup, {
    asked: "auto",
    name: "browser-light",
    colourScheme: "light",
  });
});

/**
 * Compositing must not perturb the premise everything else rests on (ADR 0001).
 * The surround is rendered afresh by every Run, so this is the assertion that
 * says rendering it is as repeatable as capturing the Frames was.
 */
test("two Runs of an Action inside a Mockup stay byte-identical", async () => {
  assert.deepEqual(again.frames.hashes, inWindow.frames.hashes);
  assert.deepEqual(again.mockup, inWindow.mockup);

  assert.deepEqual(await artifactsOf(again), await artifactsOf(inWindow));
});

test("the rendered surround is swept up with the Frames it was composited around", async () => {
  assert.deepEqual((await readdir(inWindow.directory)).sort(), [
    "peek.embed.html",
    "peek.gif",
    "peek.mp4",
    "peek.webm",
    "run.json",
  ]);
});

/**
 * Adding a Mockup is adding a template, so every preset that ships has to come
 * out of one code path. The contact sheet is where that is visible: one Frame
 * of a real Project, put through the same rendering, measuring and compositing
 * as a Run's, once per preset.
 */
test("`mockups <project> <action>` renders every preset around a Frame of the Action", async () => {
  const { stdout, stderr, code } = await record(workspace, "mockups", "demo", "peek", "--json");
  assert.equal(code, 0, stderr);

  const sheet = JSON.parse(stdout) as ContactSheetReport;

  assert.deepEqual(
    sheet.mockups.map((entry) => entry.mockup),
    ["none", "rounded", "browser-light", "browser-dark", "laptop", "phone"],
    "every preset that ships, and the undecorated one to judge them against",
  );

  for (const entry of sheet.mockups) {
    assert.equal(entry.width, bareSize.width, `${entry.mockup} is as wide as the video Artifacts`);
    assert.deepEqual(
      await probeSize(entry.image),
      { width: entry.width, height: entry.height },
      `${entry.mockup} was rendered at the size it reported`,
    );
  }

  // Only the undecorated one is the shape of the Frames themselves.
  const bareEntry = sheet.mockups.find((entry) => entry.mockup === "none");
  assert.deepEqual({ width: bareEntry?.width, height: bareEntry?.height }, bareSize);

  const page = await readFile(sheet.page, "utf8");
  for (const entry of sheet.mockups) {
    assert.match(page, new RegExp(`src="${entry.mockup}\\.png"`), `${entry.mockup} is on the sheet`);
  }
  assert.doesNotMatch(page, /https?:\/\//, "the sheet makes no external request");
});

test("`mockups` on its own names every Mockup without recording anything", async () => {
  const { stdout, code } = await record(workspace, "mockups", "--json");

  assert.equal(code, 0);
  assert.deepEqual(
    (JSON.parse(stdout) as { name: string }[]).map((mockup) => mockup.name),
    ["rounded", "browser-light", "browser-dark", "laptop", "phone"],
  );
});

/**
 * A name nobody wrote a template for is refused where it was written, because
 * every Action of the Project would otherwise fail one at a time saying the
 * same thing.
 */
test("a Project naming a Mockup that does not exist is refused, naming its file", async () => {
  await projectIn(workspace, "muddled", project(site.url, 'mockup = "chrome"'));

  const { stderr, code } = await record(workspace, "projects");

  assert.equal(code, 1);
  assert.match(stderr, /project\.toml: 'mockup' is 'chrome', which is not one of auto, none, rounded/);
});

test("an Override naming a Mockup that does not exist is refused as it is set", async () => {
  const { stderr, code } = await record(workspace, "set", "demo", "peek", "mockup=chrome");

  assert.equal(code, 1);
  assert.match(stderr, /'mockup' takes one of auto, none, rounded, browser-light/);
});

/** The Artifact of one format a Run reported, or a failure naming what is missing. */
function artifact(report: RunReport, format: string): string {
  const found = report.artifacts.find((candidate) => candidate.format === format);
  assert.ok(found !== undefined, `the Run reported no ${format}`);
  return found.path;
}
