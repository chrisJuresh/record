/**
 * The drawn cursor, asserted at the CLI seam against the fixture site.
 *
 * No Frame contains the operating system's pointer and there is no real mouse
 * in a stepped headless browser, so the cursor is drawn -- and the only place
 * to find out whether something was drawn is the Frames. Every
 * assertion here is therefore a comparison of what two Runs captured: the same
 * Action with a cursor and without one, in one style and another, captioned and
 * not.
 *
 * Hashes rather than images, which is also all a Run leaves behind.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { ParameterReport, RunReport } from "@record/core";

import { actionIn, record, removeWorkspaces, workspaceWith } from "./harness.js";

/** The fixture site's controls are pinned to its top-left corner. */
const toggle = { x: 53, y: 22 };

/**
 * Small on purpose, and it both clicks and types: those are the two primitives
 * a pointer explains, and so the two that turn it on without being asked.
 */
const tap = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 10, min: 1, max: 120 },
} as const;

const tap: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate, startsAt: { scrollTop: 0, cursor: { x: 200, y: 150 } } })
      .waitFor("window.fixtureReady === true", { durationMs: 100, describes: "the fixture site" })
      .moveCursorTo({ x: ${toggle.x}, y: ${toggle.y} }, { durationMs: 200 })
      .click()
      .hold(200)
      .type("ok", { perKeyMs: 100 })
      .hold(300);
  },
};

export default tap;
`;

/**
 * The same size of clip, travelling only. It places a cursor and never uses
 * it, which is the Action a pointer would sit idle in -- and so the Action the
 * default has to keep one out of.
 */
const drift = `
import { motion, type Action } from "@record/core";

const drift: Action<{}> = {
  parameters: {},
  timeline() {
    return motion({ framerate: 10, startsAt: { scrollTop: 0, cursor: { x: 200, y: 150 } } })
      .hold(100)
      .scrollTo(120, { durationMs: 400, easing: "linear" })
      .hold(100);
  },
};

export default drift;
`;

/** Travel that never places a cursor at all, so there is none to be drawn. */
const peek = withoutACursor(drift, "peek");

/** Typing with no cursor placed: keys need no pointer, and this Action has none. */
const shortcut = withoutACursor(
  drift.replace(
    `.scrollTo(120, { durationMs: 400, easing: "linear" })`,
    `.press("Escape").type("ok", { perKeyMs: 100 })`,
  ),
  "shortcut",
);

/** The same Action with nowhere for a cursor to be, under a name of its own. */
function withoutACursor(source: string, name: string): string {
  return source
    .replace("startsAt: { scrollTop: 0, cursor: { x: 200, y: 150 } }", "startsAt: { scrollTop: 0 }")
    .replaceAll("drift", name);
}

let site: FixtureSite;
let workspace: string;

/**
 * One Run per way of drawing, recorded once and read by every test. Each is the
 * same Timeline under a name of its own, because an Override belongs to one
 * Action and a Run writes over the last Run of the Action it recorded.
 */
let drawn: RunReport;
let again: RunReport;
let hidden: RunReport;
let arrow: RunReport;
let captioned: RunReport;
let idle: RunReport;
let idleShown: RunReport;

before(async () => {
  site = await startFixtureSite();
  workspace = await workspaceWith({
    demo: [
      `base_url = "${site.url}"`,
      `source_repository = "."`,
      "video_width = 320",
      'mockup = "none"',
      "",
      "[viewport]",
      "width = 400",
      "height = 300",
      "device_scale_factor = 1",
      "",
    ].join("\n"),
  });

  for (const name of ["tap", "tap-hidden", "tap-arrow", "tap-captioned"]) {
    await actionIn(workspace, "demo", name, tap);
  }
  for (const name of ["drift", "drift-shown"]) {
    await actionIn(workspace, "demo", name, drift);
  }
  await actionIn(workspace, "demo", "peek", peek);
  await actionIn(workspace, "demo", "shortcut", shortcut);

  drawn = await recordRun("tap");
  again = await recordRun("tap");
  hidden = await recordRun("tap-hidden", "--set", "cursor=hidden");
  arrow = await recordRun("tap-arrow", "--set", "cursorStyle=arrow-light");
  captioned = await recordRun("tap-captioned", "--set", "cursorCaptions=true");
  idle = await recordRun("drift");
  idleShown = await recordRun("drift-shown", "--set", "cursor=shown");
});

after(async () => {
  await site.close();
  await removeWorkspaces();
});

async function recordRun(action: string, ...args: string[]): Promise<RunReport> {
  const { stdout, stderr, code } = await record(workspace, "run", "demo", action, ...args, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as RunReport;
}

async function parameters(...args: string[]): Promise<ParameterReport> {
  const { stdout, stderr, code } = await record(workspace, ...args, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as ParameterReport;
}

/**
 * The premise the drawn cursor rests on, and the same one ADR 0001 rests on:
 * position, press and the ripples a click sends out all come off the Timeline,
 * so two Runs of the Action draw the same pointer in the same places rather
 * than whatever an animation in the page felt like that time.
 */
test("a cursor drawn from the Timeline is the same cursor in every Run", () => {
  assert.deepEqual(drawn.cursor, { shown: true, style: "soft-dot", captions: false });
  assert.deepEqual(again.frames.hashes, drawn.frames.hashes);
});

test("an Action that clicks or types draws a cursor without being asked, and one that only scrolls does not", () => {
  assert.equal(drawn.cursor.shown, true);
  assert.equal(idle.cursor.shown, false);

  // ...and the default really is what kept it out of the clip: the same Action
  // asked for one has it, in the same Frames.
  assert.equal(idleShown.cursor.shown, true);
  assert.equal(idleShown.frames.captured, idle.frames.captured);
  assert.notDeepEqual(idleShown.frames.hashes, idle.frames.hashes);
});

/**
 * Typing needs no pointer, and an Action can type without ever placing one.
 * The default draws a cursor for an Action that types, so this is the case
 * where there is none to draw: it records with none rather than failing over
 * a default nobody asked for.
 */
test("an Action that types without placing a cursor records with none rather than failing", async () => {
  const recorded = await recordRun("shortcut");

  assert.deepEqual(recorded.cursor, { shown: false, style: "soft-dot", captions: false });
});

/**
 * An Override that quietly does nothing is worse than one that fails, and a
 * cursor asked for where the Action never placed one could only ever be drawn
 * nowhere.
 */
test("asking for a cursor in an Action that never places one fails saying so", async () => {
  const { stderr, code } = await record(workspace, "run", "demo", "peek", "--set", "cursor=shown");

  assert.equal(code, 1);
  assert.match(stderr, /never places a cursor, so there is none to draw/);
});

/**
 * What the cursor is for: it has to be in the picture. The clip is otherwise
 * identical -- the same Timeline, the same Frames, the same clicks dispatched
 * to the page -- so the Frames can only differ by what was drawn over them.
 */
test("the drawn cursor reaches the Frames, and turning it off leaves them as they were", () => {
  assert.equal(hidden.cursor.shown, false);
  assert.equal(hidden.frames.captured, drawn.frames.captured);
  assert.notDeepEqual(hidden.frames.hashes, drawn.frames.hashes);
});

test("the style is what is drawn, so choosing another draws another", () => {
  assert.equal(arrow.cursor.style, "arrow-light");
  assert.equal(arrow.frames.captured, drawn.frames.captured);
  assert.notDeepEqual(arrow.frames.hashes, drawn.frames.hashes);
});

/**
 * Captions are opt-in: a clip explaining a keyboard shortcut wants them and a
 * clip of somebody filling in a form does not, so nothing is captioned until an
 * Action is tuned to caption it.
 */
test("keystroke captions are off until they are turned on, and then they are in the Frames", () => {
  assert.equal(drawn.cursor.captions, false);
  assert.equal(captioned.cursor.captions, true);
  assert.equal(captioned.frames.captured, drawn.frames.captured);
  assert.notDeepEqual(captioned.frames.hashes, drawn.frames.hashes);
});

/**
 * Adding a cursor is adding a registry entry. What that buys is that every
 * style that ships is settable without anything else knowing it exists, which
 * is what this asks the command.
 */
test("every cursor style that ships is one an Action can be tuned to, and nothing else is", async () => {
  const reported = await parameters("parameters", "demo", "tap");
  const styles = reported.parameters.find((parameter) => parameter.name === "cursorStyle");

  assert.deepEqual(styles?.choices, ["soft-dot", "arrow-light", "arrow-dark"]);
  assert.equal(styles?.value, "soft-dot");

  for (const style of styles?.choices ?? []) {
    const set = await record(workspace, "set", "demo", "tap-arrow", `cursorStyle=${style}`);
    assert.equal(set.code, 0, set.stderr);
  }

  const refused = await record(workspace, "set", "demo", "tap-arrow", "cursorStyle=squiggle");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /'cursorStyle' takes one of soft-dot, arrow-light, arrow-dark/);
});

test("the cursor Parameters are carried by an Action that says nothing about a cursor", async () => {
  const reported = await parameters("parameters", "demo", "drift");

  assert.deepEqual(
    reported.parameters.map((parameter) => [parameter.name, parameter.value]),
    [
      ["cursor", "auto"],
      ["cursorStyle", "soft-dot"],
      ["cursorCaptions", false],
      ["mockup", "none"],
      ["gifWidth", 640],
      ["gifFramerate", 20],
    ],
  );
});
