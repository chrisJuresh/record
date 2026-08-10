/**
 * Matrix Runs, asserted at the CLI seam.
 *
 * What is being asserted is that one request produces several Runs that are
 * Runs in every ordinary sense -- kept apart, named apart, prunable apart, and
 * queued for the machine beside every other Run -- and that the page really was
 * put into the condition each of them claims. The last of those is the one that
 * matters: a clip named `-dark` that is light is exactly the sort of quietly
 * wrong output this tool exists not to produce, so the colour scheme is read
 * back off the page rather than assumed from the switch having been thrown.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { RunReport, RunSummary } from "@record/core";

import { actionIn, artifactsOf, record, removeWorkspaces, workspaceWith } from "./harness.js";

const execute = promisify(execFile);

/** Four Frames of a page travelling a little: enough to be a clip, and no more. */
const peek = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 10, min: 1, max: 120 },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate }).hold(100).scrollTo(60, { durationMs: 200 }).hold(100);
  },
};

export default peek;
`;

/**
 * How a Project that themes itself is switched. Written as the two expressions
 * a `project.toml` declares, because what is under test is that a Project can
 * say this at all.
 */
const themeHook = {
  light: `document.documentElement.dataset.theme = "light"`,
  dark: `document.documentElement.dataset.theme = "dark"`,
};

let site: FixtureSite;
let workspace: string;

/** The one plain Run, recorded first so that nothing about it can have moved. */
let plain: RunReport;
/** The same Action across light and dark, against a page that follows the preference. */
let schemes: RunSummary;
/** ...and against a page that themes itself, with and without the Project's hook. */
let hooked: RunSummary;
let unhooked: RunSummary;
/** Two schemes against two widths, recorded at once and one at a time. */
let crossed: RunSummary;
let serial: RunSummary;

before(async () => {
  site = await startFixtureSite();

  workspace = await workspaceWith({
    // Follows the reader's preference and nothing else, and says nothing about
    // themes in its own configuration.
    preferred: project(`${site.url}scheme.html`),
    // Themes itself from an attribute, and declares the hook that sets it.
    hooked: project(`${site.url}themed.html`, themeHook),
    // The same page, with no hook declared: what emulation alone can do to it.
    unhooked: project(`${site.url}themed.html`),
  });

  for (const name of ["preferred", "hooked", "unhooked"]) {
    await actionIn(workspace, name, "peek", peek);
  }

  plain = await recordOne("preferred", "peek");
  schemes = await recordMatrix("preferred", "peek", "--scheme", "light,dark");
  hooked = await recordMatrix("hooked", "peek", "--scheme", "light,dark");
  unhooked = await recordMatrix("unhooked", "peek", "--scheme", "dark");

  const cross = ["--scheme", "light,dark", "--width", "320,480"];
  crossed = await recordMatrix("preferred", "peek", ...cross);
  serial = await recordMatrix("preferred", "peek", ...cross, "--concurrency", "1");
}, { timeout: 900_000 });

after(async () => {
  await site.close();
  await removeWorkspaces();
});

/** A Project pointed at one page of the fixture site, which is answering already. */
function project(baseUrl: string, theme?: { light: string; dark: string }): string {
  return [
    `base_url = ${JSON.stringify(baseUrl)}`,
    `source_repository = "."`,
    "video_width = 320",
    'mockup = "none"',
    "",
    "[viewport]",
    "width = 400",
    "height = 300",
    "device_scale_factor = 1",
    "",
    ...(theme === undefined
      ? []
      : ["[theme]", `light = ${JSON.stringify(theme.light)}`, `dark = ${JSON.stringify(theme.dark)}`, ""]),
  ].join("\n");
}

async function recordOne(project: string, action: string): Promise<RunReport> {
  const { stdout, stderr, code } = await record(workspace, "run", project, action, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as RunReport;
}

async function recordMatrix(
  project: string,
  action: string,
  ...options: string[]
): Promise<RunSummary> {
  const { stdout, stderr, code } = await record(
    workspace,
    "run",
    project,
    action,
    ...options,
    "--json",
  );
  assert.equal(code, 0, stderr);

  const summary = JSON.parse(stdout) as RunSummary;
  assert.deepEqual(summary.failures, [], "a Condition failed to record");

  return summary;
}

/** The Run of one Condition, or a failure naming the Condition that is missing. */
function under(summary: RunSummary, condition: string): RunReport {
  const run = summary.runs.find((one) => one.condition?.name === condition);
  assert.ok(run !== undefined, `nothing recorded '${condition}'`);

  return run;
}

/** What one Run's Artifacts are called, without the machine's path in front of them. */
function artifactNames(run: RunReport): string[] {
  return run.artifacts.map((artifact) => basename(artifact.path)).sort();
}

/**
 * A Matrix is several Runs from one request, so even a single Action reports as
 * a summary -- and each Condition's Artifacts are named apart, because the clip
 * of the light theme and the clip of the dark one are two clips.
 */
test("one command records an Action across light and dark, into separately named Artifacts", async () => {
  assert.deepEqual(schemes.conditions, ["light", "dark"]);
  assert.deepEqual(
    schemes.runs.map((run) => run.condition?.name),
    ["light", "dark"],
  );

  for (const condition of ["light", "dark"]) {
    const run = under(schemes, condition);

    assert.equal(
      run.directory,
      join(workspace, "runs", "preferred", "peek", "conditions", condition, run.id),
      "a Condition keeps a directory of its own, so it has a Latest of its own",
    );
    assert.deepEqual(artifactNames(run), [
      `peek-${condition}.gif`,
      `peek-${condition}.mp4`,
      `peek-${condition}.webm`,
    ]);
    assert.deepEqual((await readdir(run.directory)).sort(), [
      `peek-${condition}.embed.html`,
      `peek-${condition}.gif`,
      `peek-${condition}.mp4`,
      `peek-${condition}.webm`,
      "run.json",
    ]);
  }

  assert.notDeepEqual(
    under(schemes, "dark").frames.hashes,
    under(schemes, "light").frames.hashes,
    "the two Conditions photographed the same page",
  );
});

/**
 * The default costs the Project nothing: `preferred` declares no theme at all,
 * and the page is put into each scheme by telling the browser what the reader
 * prefers. The proof is the page's own answer, read back after it settled.
 */
test("theme switching works via emulated colour-scheme with no Project configuration", () => {
  const light = under(schemes, "light");
  const dark = under(schemes, "dark");

  assert.deepEqual(light.condition, {
    name: "light",
    scheme: "light",
    width: null,
    switched: "emulated",
  });
  assert.deepEqual(dark.condition, { name: "dark", scheme: "dark", width: null, switched: "emulated" });

  assert.equal(light.mockup.colourScheme, "light");
  assert.equal(dark.mockup.colourScheme, "dark");
});

/**
 * ...and a Project whose theme is its own business is switched by its own hook.
 * The same page recorded without a hook declared is what makes this an
 * assertion rather than a coincidence: emulation alone cannot move it, so the
 * hook is what did.
 */
test("a Project can declare a theme hook, and it is used in preference to media emulation", () => {
  const light = under(hooked, "light");
  const dark = under(hooked, "dark");

  assert.equal(light.condition?.switched, "hook");
  assert.equal(dark.condition?.switched, "hook");

  assert.equal(light.mockup.colourScheme, "light");
  assert.equal(dark.mockup.colourScheme, "dark");

  const withoutOne = under(unhooked, "dark");

  assert.equal(withoutOne.condition?.switched, "emulated");
  assert.equal(
    withoutOne.mockup.colourScheme,
    "light",
    "this page ignores the media query, so emulating it must not have moved it",
  );
});

/**
 * Recording at several widths is what shows a responsive layout, so the width
 * has to reach the browser rather than only the report -- which the encoded
 * Artifacts say, since a narrower page is a taller clip at the same width.
 */
test("one command records an Action at several viewport widths", async () => {
  const narrow = under(crossed, "light-320w");
  const wide = under(crossed, "light-480w");

  assert.equal(narrow.condition?.width, 320);
  assert.equal(wide.condition?.width, 480);

  // 320 wide at the Project's 300-tall viewport, and the same Artifact width
  // over a wider page -- so the two are comparable side by side.
  assert.deepEqual(await encoded(narrow), { width: 320, height: 300 });
  assert.deepEqual(await encoded(wide), { width: 320, height: 200 });
});

/** Two schemes against two widths is four Conditions, each named for both. */
test("a Matrix multiplies the conditions it was given", () => {
  const expected = ["light-320w", "light-480w", "dark-320w", "dark-480w"];

  assert.deepEqual(crossed.conditions, expected);
  assert.deepEqual(
    crossed.runs.map((run) => run.condition?.name),
    expected,
  );

  assert.deepEqual(artifactNames(under(crossed, "dark-480w")), [
    "peek-dark-480w.gif",
    "peek-dark-480w.mp4",
    "peek-dark-480w.webm",
  ]);
});

/**
 * A Condition varies the circumstances the page is photographed under and not
 * what a Frame is, so a Matrix queues for the machine with every other Run --
 * and, per ADR 0001, records the same bytes however many of them are going at
 * once. This is the parallel suite's assertion made about a Matrix.
 */
test("Matrix Runs record at once, and produce what they produce one at a time", async () => {
  assert.equal(crossed.concurrency, 4);
  assert.equal(serial.concurrency, 1);

  for (const condition of crossed.conditions) {
    const many = under(crossed, condition);
    const one = under(serial, condition);

    assert.deepEqual(many.frames.hashes, one.frames.hashes, `the Frames of '${condition}'`);
    assert.deepEqual(await artifactsOf(many), await artifactsOf(one), `the Artifacts of '${condition}'`);
  }
});

/**
 * ...and they really did overlap. Measured against how far apart the same four
 * Runs began one at a time, so nothing about how fast this machine happens to
 * be decides it.
 */
test("a Matrix records several Conditions at once rather than one after the other", () => {
  const spread = (summary: RunSummary) => {
    const began = summary.runs.map((run) => Date.parse(run.recordedAt));
    return Math.max(...began) - Math.min(...began);
  };

  assert.ok(
    spread(crossed) * 2 < spread(serial),
    `began within ${spread(crossed)}ms at once, and ${spread(serial)}ms one at a time`,
  );
});

/** A request that varies nothing records exactly what it always has. */
test("a Run asked for on its own is unchanged by the feature", async () => {
  assert.equal(plain.condition, null);
  assert.equal(plain.directory, join(workspace, "runs", "preferred", "peek", plain.id));
  assert.deepEqual(artifactNames(plain), ["peek.gif", "peek.mp4", "peek.webm"]);
  assert.deepEqual((await readdir(plain.directory)).sort(), [
    "peek.embed.html",
    "peek.gif",
    "peek.mp4",
    "peek.webm",
    "run.json",
  ]);
});

/**
 * A Matrix's Runs are Runs of the Action they were asked for, so they are
 * listed among its own -- each naming the Condition it recorded under, since
 * that is the only thing telling one of eleven Runs from another.
 */
test("history lists a Matrix's Runs among the Action's own, newest first", async () => {
  const { stdout, stderr, code } = await record(workspace, "history", "preferred", "peek", "--json");
  assert.equal(code, 0, stderr);

  const kept = JSON.parse(stdout) as RunReport[];

  assert.deepEqual(
    [...kept].map((run) => run.id).sort().reverse(),
    kept.map((run) => run.id),
    "history reads newest first",
  );

  assert.deepEqual(
    [...new Set(kept.map((run) => run.condition?.name ?? "none"))].sort(),
    ["dark", "dark-320w", "dark-480w", "light", "light-320w", "light-480w", "none"],
  );

  assert.equal(kept.at(-1)?.id, plain.id, "the plain Run is the oldest of them, and still there");
});

test("`--scheme` takes a colour scheme this tool records in, and refuses anything else", async () => {
  const { stderr, code } = await record(workspace, "run", "preferred", "peek", "--scheme", "sepia");

  assert.equal(code, 1);
  assert.match(stderr, /'sepia' is not a colour scheme to record in/);
});

test("`--width` takes whole CSS pixels within a range, and refuses anything else", async () => {
  for (const [given, said] of [
    ["lots", /'lots' is not a viewport width to record at/],
    ["480.5", /'480.5' is not a viewport width to record at/],
    ["4", /is not a viewport width to record at: they run 120 to 7680/],
  ] as const) {
    const { stderr, code } = await record(workspace, "run", "preferred", "peek", "--width", given);

    assert.equal(code, 1, `--width ${given} was accepted`);
    assert.match(stderr, said);
  }
});

/**
 * Two Runs kept under one name would each write over what the other reported,
 * and quietly recording one of them is not what was asked for either.
 */
test("a condition asked for twice is refused rather than recorded once", async () => {
  const { stderr, code } = await record(
    workspace,
    "run",
    "preferred",
    "peek",
    "--scheme",
    "light,light",
  );

  assert.equal(code, 1);
  assert.match(stderr, /the colour scheme 'light' is asked for twice/);
});

test("`--scheme` and `--width` name a list, and say so when given none", async () => {
  for (const option of ["--scheme", "--width"]) {
    const { stderr, code } = await record(workspace, "run", "preferred", "peek", option);

    assert.equal(code, 1, `${option} with nothing after it was accepted`);
    assert.match(stderr, new RegExp(`\\${option} takes a comma-separated list`));
  }
});

test("only run records a Matrix", async () => {
  const { stderr, code } = await record(workspace, "mockups", "--scheme", "dark");

  assert.equal(code, 1);
  assert.match(stderr, /only run takes --scheme/);
});

/**
 * A Matrix of one Action is several Runs, so how many record at once is worth
 * asking for -- unlike one Action recorded on its own, which records once.
 */
test("`--concurrency` alongside one Action is refused only where it records once", async () => {
  const { stderr, code } = await record(
    workspace,
    "run",
    "preferred",
    "peek",
    "--concurrency",
    "2",
  );

  assert.equal(code, 1);
  assert.match(stderr, /--concurrency is how many Actions record at once/);
});

test("naming an Action the Project does not declare fails the Matrix rather than each Condition", async () => {
  const { stderr, code } = await record(
    workspace,
    "run",
    "preferred",
    "nothing-like-it",
    "--scheme",
    "light,dark",
  );

  assert.equal(code, 1);
  assert.match(stderr, /no Action named 'nothing-like-it' is declared by Project 'preferred'/);
});

/** What ffprobe says an Artifact actually is, rather than what it was meant to be. */
async function encoded(run: RunReport): Promise<{ width: number; height: number }> {
  const artifact = run.artifacts.find((one) => one.format === "mp4");
  assert.ok(artifact !== undefined, "the Run reported no mp4");

  const { stdout } = await execute("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    artifact.path,
  ]);

  const probed = JSON.parse(stdout) as { streams?: { width: number; height: number }[] };
  const stream = probed.streams?.[0];
  assert.ok(stream !== undefined, `ffprobe found no video stream in ${artifact.path}`);

  return { width: stream.width, height: stream.height };
}
