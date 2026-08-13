/**
 * Parameters and Overrides at the CLI seam.
 *
 * None of this needs a browser, and none of it should: whether a hand-tuned
 * value reaches the Action is a question about files and declarations, and
 * asking it through a recording would make it a question nobody asks.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ParameterReport } from "@record/core";

import { actionIn, record, removeWorkspaces, workspaceWith } from "./harness.js";

after(removeWorkspaces);

const configured = `
base_url = "http://127.0.0.1:4173/"
source_repository = "."
`;

/** Written the way an Action is written: over the primitives, from the package. */
const peek = `
import { motion, type Action } from "@record/core";

const parameters = {
  distance: { kind: "number", describes: "how far the page travels", default: 200, min: 0, max: 2000 },
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
  easing: { kind: "easing", describes: "how the travel settles", default: "ease-in-out-cubic" },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ distance, framerate, easing }) {
    return motion({ framerate })
      .hold(100)
      .scrollTo(distance, { durationMs: 400, easing })
      .hold(100);
  },
};

export default peek;
`;

/** A workspace holding one Project with one Action, and the Action's sidecar path. */
async function tunable(): Promise<{ workspace: string; sidecar: string }> {
  const workspace = await workspaceWith({ demo: configured });
  await actionIn(workspace, "demo", "peek", peek);

  return {
    workspace,
    sidecar: join(workspace, "projects", "demo", "actions", "peek.overrides.toml"),
  };
}

async function parameters(workspace: string, ...args: string[]): Promise<ParameterReport> {
  const { stdout, stderr, code } = await record(workspace, ...args, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as ParameterReport;
}

test("`parameters --json` reports what an Action declares and what it will run with", async () => {
  const { workspace, sidecar } = await tunable();

  const reported = await parameters(workspace, "parameters", "demo", "peek");

  assert.equal(reported.project, "demo");
  assert.equal(reported.action, "peek");
  assert.equal(reported.sidecar, sidecar);
  assert.deepEqual(reported.warnings, []);
  assert.deepEqual(reported.parameters, [
    {
      name: "distance",
      kind: "number",
      describes: "how far the page travels",
      default: 200,
      min: 0,
      max: 2000,
      value: 200,
      overridden: false,
    },
    {
      name: "framerate",
      kind: "number",
      describes: "Frames per second",
      default: 20,
      min: 1,
      max: 120,
      value: 20,
      overridden: false,
    },
    {
      name: "easing",
      kind: "easing",
      describes: "how the travel settles",
      default: "ease-in-out-cubic",
      // An easing takes one of a named set exactly as a choice does, and what
      // that set is belongs in the report: whatever offers it as a control
      // otherwise has to keep a second copy of the four names.
      choices: ["linear", "ease-in-cubic", "ease-out-cubic", "ease-in-out-cubic"],
      value: "ease-in-out-cubic",
      overridden: false,
    },
    {
      name: "cursor",
      kind: "choice",
      describes: "Whether the cursor is drawn -- automatically for an Action that clicks or types",
      default: "auto",
      choices: ["auto", "shown", "hidden"],
      value: "auto",
      overridden: false,
    },
    {
      name: "cursorStyle",
      kind: "choice",
      describes: "Which cursor is drawn",
      default: "soft-dot",
      choices: ["soft-dot", "arrow-light", "arrow-dark"],
      value: "soft-dot",
      overridden: false,
    },
    {
      name: "cursorCaptions",
      kind: "flag",
      describes: "Caption the keys the Action strikes on screen",
      default: false,
      value: false,
      overridden: false,
    },
    {
      name: "mockup",
      kind: "choice",
      describes: "The surround composited around the Frames",
      // The Project said nothing about a surround, so this Action carries what
      // a Project that says nothing gets.
      default: "auto",
      choices: ["auto", "none", "rounded", "browser-light", "browser-dark", "laptop", "phone"],
      value: "auto",
      overridden: false,
    },
    {
      name: "gifWidth",
      kind: "number",
      describes: "Width the GIF is encoded at, in pixels",
      default: 640,
      min: 120,
      max: 1920,
      value: 640,
      overridden: false,
    },
    {
      name: "gifFramerate",
      kind: "number",
      describes: "Frames per second the GIF plays at",
      default: 20,
      min: 5,
      max: 50,
      value: 20,
      overridden: false,
    },
  ]);
});

/**
 * The GIF's size levers are Parameters rather than constants (ADR 0006), and
 * they are not motion, so no Action declares them -- every Action carries them,
 * and a new Action is tunable the moment it exists.
 */
test("every Action carries the Artifact Parameters, tunable without touching the module", async () => {
  const { workspace, sidecar } = await tunable();

  const reported = await parameters(workspace, "set", "demo", "peek", "gifWidth=480");

  assert.deepEqual(
    reported.parameters.slice(-2).map((parameter) => [parameter.name, parameter.value, parameter.overridden]),
    [
      ["gifWidth", 480, true],
      ["gifFramerate", 20, false],
    ],
  );

  assert.match(await readFile(sidecar, "utf8"), /gifWidth = 480/);
  assert.doesNotMatch(
    await readFile(join(workspace, "projects", "demo", "actions", "peek.ts"), "utf8"),
    /gifWidth/,
    "the Action says nothing about the GIF, and does not have to",
  );

  const refused = await record(workspace, "set", "demo", "peek", "gifWidth=4000");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /'gifWidth' takes a number between 120 and 1920, not 4000/);
});

test("`set` writes an Override to the sidecar beside the Action, not into it", async () => {
  const { workspace, sidecar } = await tunable();

  const reported = await parameters(workspace, "set", "demo", "peek", "distance=240", "easing=linear");

  assert.deepEqual(
    reported.parameters.map((parameter) => [parameter.name, parameter.value, parameter.overridden]),
    [
      ["distance", 240, true],
      ["framerate", 20, false],
      ["easing", "linear", true],
      ["cursor", "auto", false],
      ["cursorStyle", "soft-dot", false],
      ["cursorCaptions", false, false],
      ["mockup", "auto", false],
      ["gifWidth", 640, false],
      ["gifFramerate", 20, false],
    ],
  );

  assert.match(await readFile(sidecar, "utf8"), /distance = 240/);
  assert.match(
    await readFile(join(workspace, "projects", "demo", "actions", "peek.ts"), "utf8"),
    /default: 200/,
    "the Action module is left exactly as it was (ADR 0005)",
  );
});

test("an Override survives being read back, and stays until it is reset", async () => {
  const { workspace } = await tunable();

  await record(workspace, "set", "demo", "peek", "distance=240");
  const reported = await parameters(workspace, "parameters", "demo", "peek");

  assert.equal(reported.parameters[0]?.value, 240);
  assert.equal(reported.parameters[0]?.overridden, true);
  assert.equal(reported.parameters[0]?.default, 200, "the declaration is untouched");
});

test("`reset` removes the Override and restores the declared default", async () => {
  const { workspace, sidecar } = await tunable();

  await record(workspace, "set", "demo", "peek", "distance=240", "easing=linear");
  const reported = await parameters(workspace, "reset", "demo", "peek", "distance");

  assert.equal(reported.parameters[0]?.value, 200);
  assert.equal(reported.parameters[0]?.overridden, false);
  assert.match(await readFile(sidecar, "utf8"), /easing = "linear"/, "the other Override stays");
});

/** Resetting the last Override is deleting the file, which is what ADR 0005 makes it. */
test("an Action with nothing tuned has no sidecar at all", async () => {
  const { workspace, sidecar } = await tunable();

  await record(workspace, "set", "demo", "peek", "distance=240");
  await record(workspace, "reset", "demo", "peek", "distance");

  await assert.rejects(readFile(sidecar, "utf8"), /ENOENT/);
});

test("resetting a Parameter that was never overridden says so rather than passing", async () => {
  const { workspace } = await tunable();

  const { stderr, code } = await record(workspace, "reset", "demo", "peek", "distance");

  assert.equal(code, 1);
  assert.match(stderr, /'distance' is not overridden/);
});

/**
 * The one gate hand-typed values come in through. A value refused here was
 * never written down, so the person setting it finds out immediately rather
 * than from a clip that looks wrong.
 */
test("`set` refuses a value the declaration will not take, naming the range", async () => {
  const { workspace, sidecar } = await tunable();

  const outOfRange = await record(workspace, "set", "demo", "peek", "distance=4000");
  assert.equal(outOfRange.code, 1);
  assert.match(outOfRange.stderr, /'distance' takes a number between 0 and 2000, not 4000/);

  const unknown = await record(workspace, "set", "demo", "peek", "wobble=3");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /'wobble' is not a Parameter this Action declares/);

  await assert.rejects(readFile(sidecar, "utf8"), /ENOENT/, "nothing refused was written down");
});

/**
 * An Action may be rewritten under a sidecar that was tuned against the old
 * one. That costs a line of output rather than the Run, but it is never passed
 * over in silence -- including when the output is being read by a machine,
 * which is when it would otherwise vanish.
 */
test("an Override naming a Parameter the Action no longer declares is a warning, not a silence", async () => {
  const { workspace, sidecar } = await tunable();
  await writeFile(sidecar, "distance = 240\nwobble = 3\n", "utf8");

  const { stdout, stderr, code } = await record(workspace, "parameters", "demo", "peek", "--json");

  assert.equal(code, 0);
  assert.match(stderr, /warning: Override 'wobble' names a Parameter this Action no longer declares/);

  const reported = JSON.parse(stdout) as ParameterReport;
  assert.deepEqual(reported.warnings, [
    "Override 'wobble' names a Parameter this Action no longer declares",
  ]);
  assert.equal(reported.parameters[0]?.value, 240, "the Overrides that do apply still apply");
});

test("a stale Override is cleared the same way any other is", async () => {
  const { workspace, sidecar } = await tunable();
  await writeFile(sidecar, "wobble = 3\n", "utf8");

  const reported = await parameters(workspace, "reset", "demo", "peek", "wobble");

  assert.deepEqual(reported.warnings, []);
  await assert.rejects(readFile(sidecar, "utf8"), /ENOENT/);
});

test("an Override the sidecar holds but the declaration will not take falls back, saying so", async () => {
  const { workspace, sidecar } = await tunable();
  await writeFile(sidecar, "distance = 9999\n", "utf8");

  const reported = await parameters(workspace, "parameters", "demo", "peek");

  assert.equal(reported.parameters[0]?.value, 200);
  assert.match(reported.warnings[0] ?? "", /outside the declared range 0\.\.2000/);
});

/**
 * `--set` belongs to the two commands that take a value: a Run records with it
 * and keeps it, and a Timeline is evaluated as if it applied and keeps nothing.
 * Reading what an Action is tuned to is neither.
 */
test("`--set` belongs to run and timeline, and says so anywhere else", async () => {
  const { workspace } = await tunable();

  const { stderr, code } = await record(workspace, "parameters", "demo", "peek", "--set", "distance=1");

  assert.equal(code, 1);
  assert.match(stderr, /only run and timeline take --set/);
});

test("an Override written without a value says how one is written", async () => {
  const { workspace } = await tunable();

  const { stderr, code } = await record(workspace, "set", "demo", "peek", "distance");

  assert.equal(code, 1);
  assert.match(stderr, /an Override is written name=value, not 'distance'/);
});
