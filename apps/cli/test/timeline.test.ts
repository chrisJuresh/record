/**
 * The evaluated Timeline at the CLI seam.
 *
 * None of this needs a browser and none of it should. What an Action's Timeline
 * comes to is a question about declarations and arithmetic, and it is the same
 * evaluation a Run captures from -- exposed here rather than reimplemented, so
 * that a Preview and a Run cannot disagree about what a travel does.
 *
 * Previewability is asserted here too, on the command's answer rather than
 * trusted to the app: it is the rule that stops tuning an Action from clicking
 * around somebody's real photo library.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import type { PageState, TimelineReport } from "@record/core";
import { startFixtureSite } from "@record/fixture-site";

import { actionIn, record, removeWorkspaces, workspaceWith } from "./harness.js";

after(removeWorkspaces);

/** Nothing here starts a Project, so nothing answers here. */
const configured = `
base_url = "http://127.0.0.1:1/"
source_repository = "."

[viewport]
width = 400
height = 300
`;

/**
 * A Hold at either end and a travel between them, at a framerate that makes the
 * Frame boundaries countable by hand: 100ms is two Frames at 20fps.
 */
const peek = `
import { motion, type Action } from "@record/core";

const parameters = {
  hold: { kind: "number", describes: "still at either end", default: 100, min: 0, max: 2000 },
  distance: { kind: "number", describes: "how far the page travels", default: 200, min: 0, max: 2000 },
  travel: { kind: "number", describes: "how long the travel takes", default: 400, min: 50, max: 5000 },
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
  easing: { kind: "easing", describes: "how the travel settles", default: "linear" },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ hold, distance, travel, framerate, easing }) {
    return motion({ framerate })
      .hold(hold)
      .scrollTo(distance, { durationMs: travel, easing })
      .hold(hold);
  },
};

export default peek;
`;

/** One Action per primitive a Preview refuses, so each refusal names its own. */
const refusing: Record<string, string> = {
  clicks: `.moveCursorTo({ x: 10, y: 10 }, { durationMs: 100 }).click()`,
  types: `.type("hello")`,
  presses: `.press("Enter")`,
  evaluates: `.evaluate("window.__whatever = 1")`,
  waits: `.waitFor("window.__ready === true", { durationMs: 200, describes: "the page" })`,
};

function actionThat(does: string): string {
  return `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
} as const;

const acts: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate, startsAt: { scrollTop: 0, cursor: { x: 0, y: 0 } } })
      .hold(100)
      ${does}
      .hold(100);
  },
};

export default acts;
`;
}

/** A workspace holding one Project with the Actions above, and the sidecar path. */
async function readable(): Promise<{ workspace: string; sidecar: string }> {
  const workspace = await workspaceWith({ demo: configured });

  await actionIn(workspace, "demo", "peek", peek);
  for (const [what, does] of Object.entries(refusing)) {
    await actionIn(workspace, "demo", what, actionThat(does));
  }

  return {
    workspace,
    sidecar: join(workspace, "projects", "demo", "actions", "peek.overrides.toml"),
  };
}

async function timeline(workspace: string, ...args: string[]): Promise<TimelineReport> {
  const { stdout, stderr, code } = await record(workspace, "timeline", ...args, "--json");
  assert.equal(code, 0, stderr);

  return JSON.parse(stdout) as TimelineReport;
}

/**
 * What a Run of this Action would cost, which is the first thing anybody tuning
 * one wants to know: two Frames of Hold, eight of travel, two of Hold.
 */
test("`timeline --json` says how long a Timeline runs and how many Frames it declares", async () => {
  const { workspace } = await readable();

  const evaluated = await timeline(workspace, "demo", "peek");

  assert.equal(evaluated.project, "demo");
  assert.equal(evaluated.action, "peek");
  assert.equal(evaluated.framerate, 20);
  assert.equal(evaluated.frames, 12);
  assert.equal(evaluated.states.length, 12);
  assert.equal(evaluated.durationMs, 600);
  assert.deepEqual(evaluated.warnings, []);
});

/**
 * A Hold is still at both ends and a travel samples from where the Timeline has
 * reached up to but not including its destination -- so the Frame after a
 * travel is the first one that is really at the far end, which is what makes a
 * Hold after it a still image rather than a frame of leftover motion.
 */
test("the states it evaluates to are still at both ends of a Hold and eased across a travel", async () => {
  const { workspace } = await readable();

  const evaluated = await timeline(workspace, "demo", "peek");
  const scrolls = evaluated.states.map((state: PageState) => state.scrollTop);

  // Two Frames of Hold at the top, eight of a linear travel to 200, two of Hold
  // at the bottom.
  assert.deepEqual(scrolls, [0, 0, 0, 25, 50, 75, 100, 125, 150, 175, 200, 200]);

  // An Action that only travels moves no cursor, captions nothing and does
  // nothing to the page -- which is the whole of why it can be previewed.
  assert.ok(evaluated.states.every((state: PageState) => state.cursor === null));
  assert.ok(evaluated.states.every((state: PageState) => state.caption === null));
  assert.ok(evaluated.states.every((state: PageState) => state.does.length === 0));
});

/**
 * The Frames of an easing are the easing's, not a straight line's -- which is
 * the whole reason the app replays this rather than working it out for itself.
 */
test("an easing changes the shape of the travel it is evaluated with", async () => {
  const { workspace } = await readable();

  const eased = await timeline(workspace, "demo", "peek", "--set", "easing=ease-in-cubic");
  const linear = await timeline(workspace, "demo", "peek");

  assert.equal(eased.frames, linear.frames, "an easing changes the shape, not the length");
  assert.notDeepEqual(
    eased.states.map((state: PageState) => state.scrollTop),
    linear.states.map((state: PageState) => state.scrollTop),
  );
  // Eased in, so it is behind the straight line for the whole of the travel.
  assert.ok(
    eased.states.every(
      (state: PageState, at: number) => state.scrollTop <= (linear.states[at]?.scrollTop ?? 0),
    ),
  );
});

/**
 * A value named here is evaluated as if it applied. That is the difference
 * between scrubbing and tuning: the app asks for evaluations continuously while
 * a control is moving, and writes an Override only once somebody settles.
 */
test("a value named to `timeline` changes what it evaluates to and writes nothing", async () => {
  const { workspace, sidecar } = await readable();

  const further = await timeline(workspace, "demo", "peek", "--set", "distance=400");

  assert.equal(further.states.at(-1)?.scrollTop, 400);
  assert.deepEqual(further.named, ["distance"]);
  assert.ok(further.overridden.includes("distance"));

  await assert.rejects(readFile(sidecar, "utf8"), /ENOENT/, "no sidecar was written");
});

test("a Timeline read under named values leaves a sidecar exactly as it was", async () => {
  const { workspace, sidecar } = await readable();

  await record(workspace, "set", "demo", "peek", "distance=300");
  const before = await readFile(sidecar, "utf8");

  const scrubbed = await timeline(workspace, "demo", "peek", "--set", "distance=1000");

  assert.equal(scrubbed.states.at(-1)?.scrollTop, 1000, "it was evaluated as if it applied");
  assert.equal(await readFile(sidecar, "utf8"), before, "and written nowhere");

  // ...and asking again without it is the Override that really is written down.
  assert.equal((await timeline(workspace, "demo", "peek")).states.at(-1)?.scrollTop, 300);
});

test("an Override already in the sidecar is what a Timeline is evaluated with", async () => {
  const { workspace } = await readable();

  await record(workspace, "set", "demo", "peek", "framerate=10");

  const evaluated = await timeline(workspace, "demo", "peek");

  assert.equal(evaluated.framerate, 10);
  assert.equal(evaluated.frames, 6);
  assert.deepEqual(evaluated.overridden, ["framerate"]);
  assert.deepEqual(evaluated.named, [], "nothing was named on the way in");
});

test("a value the Action refuses is refused in the command's own words, unwritten", async () => {
  const { workspace, sidecar } = await readable();

  const { stderr, code } = await record(workspace, "timeline", "demo", "peek", "--set", "framerate=1000");

  assert.equal(code, 1);
  assert.match(stderr, /takes a number between 1 and 120/);
  await assert.rejects(readFile(sidecar, "utf8"), /ENOENT/);
});

/**
 * An Action that only travels can be played against the live Project, and the
 * answer carries what a Preview of it needs: where the Project answers and the
 * viewport it is shown at.
 *
 * The driver is not in it, because reading a Timeline is not playing one -- a
 * Timeline is asked for again every time a control moves, and the expression
 * injected into a page has no business riding along each time.
 */
test("an Action that only travels is previewable, and says what a Preview would need", async () => {
  const { workspace } = await readable();

  const { preview } = await timeline(workspace, "demo", "peek");

  assert.equal(preview.previewable, true);
  assert.equal(preview.refusal, null);
  assert.equal(preview.baseUrl, "http://127.0.0.1:1/");
  assert.equal(preview.readyUrl, "http://127.0.0.1:1/");
  assert.deepEqual(preview.viewport, { width: 400, height: 300, deviceScaleFactor: 1 });
  assert.equal(preview.driver, null, "reading a Timeline is not turning a Preview on");
});

/**
 * A Preview drives the live site, so an Action that would really do something to
 * it is refused rather than half-played -- and the refusal names the primitive,
 * because "it does not work" is not something anybody can act on.
 */
test("an Action that clicks, types, evaluates or waits is not previewable, and says which", async () => {
  const { workspace } = await readable();

  const named: Record<string, RegExp> = {
    clicks: /'\.click\(\)'/,
    types: /'\.type\(\)'/,
    presses: /'\.press\(\)'/,
    evaluates: /'\.evaluate\(\)'/,
    waits: /'\.waitFor\(\)'/,
  };

  for (const [action, names] of Object.entries(named)) {
    const { preview } = await timeline(workspace, "demo", action);

    assert.equal(preview.previewable, false, action);
    assert.match(preview.refusal ?? "", names, action);
    assert.match(preview.refusal ?? "", /cannot be previewed/, action);
  }
});

/**
 * Reading the Timeline of an Action that cannot be previewed is still worth
 * doing -- it is how whoever wrote it reads where a click lands. It is turning
 * the Preview on that is refused, and in the same words.
 */
test("`--preview` refuses an Action that cannot be driven, in the words the answer gave", async () => {
  const { workspace } = await readable();

  const said = (await timeline(workspace, "demo", "clicks")).preview.refusal;
  const { stderr, code } = await record(workspace, "timeline", "demo", "clicks", "--preview", "--json");

  assert.equal(code, 1);
  assert.equal(stderr.trim(), said);
});

/** ...and the Frames it evaluates to name what each of them does to the page. */
test("the evaluated Timeline names what happens on each Frame", async () => {
  const { workspace } = await readable();

  const evaluated = await timeline(workspace, "demo", "clicks");
  const does = evaluated.states.flatMap((state: PageState) => state.does.map((effect) => effect.kind));

  assert.deepEqual(does, ["cursor-press", "cursor-release"]);
  assert.ok(
    evaluated.states.some((state: PageState) => state.cursor?.pressed === true),
    "and where the cursor was while it was held down",
  );
});

/**
 * A Preview requires a Project already answering, and never starts one: only a
 * Project this tool started is ever stopped, and a Preview has no reliable
 * moment of ending to stop it at.
 */
test("`--preview` names the Project and its URL when there is nothing answering", async () => {
  const { workspace } = await readable();

  const { stderr, code } = await record(workspace, "timeline", "demo", "peek", "--preview", "--json");

  assert.equal(code, 1);
  assert.match(stderr, /Project 'demo' is not answering at http:\/\/127\.0\.0\.1:1\//);
  assert.match(stderr, /A Preview never starts a Project/);
});

/**
 * ...and for a Project that is up it is the same Timeline, plus the driver the
 * page has to be given to be driven at all -- which has to find the scroller
 * the way capture finds it, or a Preview scrolls a different element than the
 * clip does.
 */
test("`--preview` answers the Timeline that was read, and the driver for the page", async () => {
  const site = await startFixtureSite();

  try {
    const workspace = await workspaceWith({
      demo: [`base_url = "${site.url}"`, 'source_repository = "."', ""].join("\n"),
    });
    await actionIn(workspace, "demo", "peek", peek);

    const played = await timeline(workspace, "demo", "peek", "--preview");
    const read = await timeline(workspace, "demo", "peek");

    assert.match(played.preview.driver ?? "", /__recordScroller/);
    assert.match(played.preview.driver ?? "", /scroll-behavior:auto/);
    assert.deepEqual(
      { ...played, preview: { ...played.preview, driver: null } },
      read,
      "and nothing else about the Timeline differs",
    );
  } finally {
    await site.close();
  }
});

/**
 * Read by a person as well as by the app: a line per Frame, because which Frame
 * is the interesting one is exactly what somebody reading this is working out.
 */
test("`timeline` read by a person says the cost, the previewability and every Frame", async () => {
  const { workspace } = await readable();

  const { stdout, code } = await record(workspace, "timeline", "demo", "peek");

  assert.equal(code, 0);
  assert.match(stdout, /12 Frames at 20fps \(0\.60s\)/);
  assert.match(stdout, /previewable against http:\/\/127\.0\.0\.1:1\//);
  assert.match(stdout, /^ {2}11 {2}scrollTop 200$/m);

  const refused = await record(workspace, "timeline", "demo", "types");

  assert.equal(refused.code, 0, "reading it is not refused; previewing it is");
  assert.match(refused.stdout, /not previewable: .*'\.type\(\)'/);
});

test("an Override the Action no longer declares is warned about rather than dropped", async () => {
  const { workspace, sidecar } = await readable();

  await writeFile(sidecar, 'wobble = 3\n', "utf8");

  const { stdout, stderr, code } = await record(workspace, "timeline", "demo", "peek", "--json");

  assert.equal(code, 0);
  assert.match(stderr, /warning: Override 'wobble' names a Parameter this Action no longer declares/);
  assert.match((JSON.parse(stdout) as TimelineReport).warnings.join("\n"), /'wobble'/);
});

test("an Action nobody declared is refused in the command's own words", async () => {
  const { workspace } = await readable();

  const { stderr, code } = await record(workspace, "timeline", "demo", "nothing-like-it", "--json");

  assert.equal(code, 1);
  assert.match(stderr, /no Action named 'nothing-like-it' is declared by Project 'demo'/);
});

test("only run and timeline take --set, and only timeline takes --preview", async () => {
  const { workspace } = await readable();

  const set = await record(workspace, "parameters", "demo", "peek", "--set", "distance=1");
  assert.equal(set.code, 1);
  assert.match(set.stderr, /only run and timeline take --set/);

  const previewing = await record(workspace, "run", "demo", "peek", "--preview");
  assert.equal(previewing.code, 1);
  assert.match(previewing.stderr, /only timeline takes --preview/);
});
