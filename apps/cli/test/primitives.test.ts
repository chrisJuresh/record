/**
 * The motion primitives that reach the page, asserted at the CLI seam against
 * the fixture site.
 *
 * A recording is the only place a click is really a click, so this is asserted
 * by recording one. What makes it observable from outside is the tool's own
 * `waitFor`: an Action that clicks, types and presses, and then waits for the
 * page to show that all three landed, fails its own Run if any of them did not.
 *
 * The conditions are chosen to fail for the *near misses* as well as the
 * obvious ones -- text that appeared in the field without the keys having been
 * pressed does not count as typing.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { RunReport } from "@record/core";

import { actionIn, record, removeWorkspaces, workspaceWith } from "./harness.js";

/**
 * The controls are pinned to the top-left corner of the fixture site, so these
 * are where they are however far the page has scrolled.
 */
const toggle = { x: 53, y: 22 };
const note = { x: 151, y: 22 };

const landed = [
  "document.body.classList.contains('clicked')",
  "window.entered === 'ok'",
  // Two characters and the Enter that followed them. Counted at keydown, so
  // text pushed into the field without the keys being pressed would not reach
  // three -- which is the difference between typing and inserting.
  "window.keystrokes === 3",
  "window.escapeHatch === true",
].join(" && ");

const interact = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 10, min: 1, max: 120 },
} as const;

const interact: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate, startsAt: { scrollTop: 0, cursor: { x: 320, y: 240 } } })
      .waitFor("window.fixtureReady === true", { durationMs: 100, describes: "the fixture site" })
      .moveCursorTo({ x: ${toggle.x}, y: ${toggle.y} }, { durationMs: 200 })
      .click()
      .scrollBy(60, { durationMs: 200 })
      .moveCursorTo({ x: ${note.x}, y: ${note.y} }, { durationMs: 200 })
      .click()
      .type("ok", { perKeyMs: 100 })
      .press("Enter")
      .evaluate("window.escapeHatch = true")
      .hold(100)
      .waitFor(${JSON.stringify(landed)}, {
        durationMs: 100,
        describes: "the click, the typing and the escape hatch to have landed",
      });
  },
};

export default interact;
`;

/** The same Action, waiting on something the fixture site never does. */
const impatient = `
import { motion, type Action } from "@record/core";

const impatient: Action<{}> = {
  parameters: {},
  timeline() {
    return motion({ framerate: 10 })
      .hold(100)
      .waitFor("window.neverHappens === true", {
        durationMs: 100,
        describes: "a thing the page never does",
      });
  },
};

export default impatient;
`;

let site: FixtureSite;
let workspace: string;

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
  await actionIn(workspace, "demo", "interact", interact);
  await actionIn(workspace, "demo", "impatient", impatient);
});

after(async () => {
  await site.close();
  await removeWorkspaces();
});

test("cursor movement, clicks, typing, keys and the escape hatch all reach the page", async () => {
  const { stdout, stderr, code } = await record(workspace, "run", "demo", "interact", "--json");

  assert.equal(code, 0, stderr);

  // 100ms waiting, 200ms travelling, 120ms clicking, 200ms scrolling, 200ms
  // travelling, 120ms clicking, 200ms typing, 120ms pressing, 100ms holding and
  // 100ms waiting, at 10fps.
  const report = JSON.parse(stdout) as RunReport;
  assert.equal(report.frames.captured, 14);
  assert.equal(report.frames.hashes.length, 14);
});

test("an Action waiting for something that never happens fails saying what it waited for", async () => {
  const { stderr, code } = await record(workspace, "run", "demo", "impatient");

  assert.equal(code, 1);
  assert.match(stderr, /waited for a thing the page never does, which never became true/);
});
