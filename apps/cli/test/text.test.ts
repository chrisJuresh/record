/**
 * Text overrides, asserted at the CLI seam against the fixture site.
 *
 * Replacement copy is only worth anything if it is in the picture, and the only
 * place to find out what a Run photographed is the Frames it photographed. So
 * every assertion here is a comparison of two Runs of the same Timeline: one
 * showing the site's own wording and one showing the wording the Action
 * declared.
 *
 * Hashes rather than images, which is also all a Run leaves behind.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { RunReport } from "@record/core";

import { actionIn, artifactsOf, record, removeWorkspaces, workspaceWith } from "./harness.js";

/** Small on purpose: every Frame is captured and encoded. */
const peek = `
import { motion, type Action } from "@record/core";

const peek: Action<{}> = {
  parameters: {},
  timeline() {
    return motion({ framerate: 10 })
      .hold(100)
      .scrollTo(120, { durationMs: 300, easing: "linear" })
      .hold(100);
  },
};

export default peek;
`;

/** The same Timeline, saying something the running site does not. */
const worded = declaring(peek, {
  "#heading": "Wording the site never had",
  ".card h2": "Rewritten",
});

/**
 * Copy for a field rather than for a heading. Text written into an input is
 * text nobody can see, so this Action is the one that says whether copy lands
 * where a viewer will read it.
 */
const field = declaring(peek, { "#note": "typed for the clip" });

/** A selector the page has nothing for, which is copy that would never land. */
const missing = declaring(peek, { "#nothing-like-it": "Never seen" });

/** A selector the page cannot even read, which is the same silence by another route. */
const unreadable = declaring(peek, { "#(": "Never seen" });

/**
 * The same Action, declaring copy to substitute into the page. What it takes is
 * unknown rather than copy, because one test declares copy that is not copy.
 */
function declaring(source: string, text: Record<string, unknown>): string {
  return source.replace("  parameters: {},", `  parameters: {},\n  text: ${JSON.stringify(text)},`);
}

let site: FixtureSite;
let workspace: string;

/**
 * One Run per way of wording the page, recorded once and read by every test.
 * The pair of Runs of the same Action is what the determinism assertion needs,
 * and an Override belongs to one Action, so each is a name of its own.
 */
let plain: RunReport;
let substituted: RunReport;
let again: RunReport;
let typed: RunReport;

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

  await actionIn(workspace, "demo", "plain", peek);
  await actionIn(workspace, "demo", "worded", worded);
  await actionIn(workspace, "demo", "field", field);
  await actionIn(workspace, "demo", "missing", missing);
  await actionIn(workspace, "demo", "unreadable", unreadable);

  plain = await recordRun("plain");
  substituted = await recordRun("worded");
  again = await recordRun("worded");
  typed = await recordRun("field");
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

/**
 * What the feature is for: the clip shows the Action's wording rather than the
 * site's. The Timeline is the same one either way, so the Frames can differ by
 * nothing but the copy that was substituted into the page.
 */
test("declared copy reaches the Frames, in place of the wording the site has", () => {
  assert.equal(substituted.frames.captured, plain.frames.captured);
  assert.notDeepEqual(substituted.frames.hashes, plain.frames.hashes);

  // ...and the Action that declared none recorded the site exactly as it is.
  assert.deepEqual(plain.text, []);
});

/**
 * A Run keeps the conditions it was produced under, and copy the site never had
 * is one of them: a clip showing wording nobody can find in the running site
 * has to say where that wording came from.
 */
test("a Run reports the copy it substituted, and what each selector matched", () => {
  assert.deepEqual(substituted.text, [
    { selector: "#heading", copy: "Wording the site never had", matched: 1 },
    { selector: ".card h2", copy: "Rewritten", matched: 16 },
  ]);
});

/**
 * Text overrides must not perturb the premise everything else rests on
 * (ADR 0001). Substitution is one pass decided entirely by the declaration, so
 * two Runs of the Action are the same Frames -- and the same bytes encoded from
 * them, not merely the same clip.
 */
test("two Runs of an Action that substitutes copy stay byte-identical", async () => {
  assert.deepEqual(again.frames.hashes, substituted.frames.hashes);
  assert.equal(again.frames.repeated, substituted.frames.repeated);
  assert.deepEqual(again.text, substituted.text);

  assert.deepEqual(await artifactsOf(again), await artifactsOf(substituted));
});

/**
 * Copy that lands invisibly is the silent skipping this feature exists to
 * refuse. Text written into an input changes nothing anybody can see, so a
 * field's copy is its value -- and the proof is that the Frames moved at all.
 */
test("copy declared for a field is what the field shows", () => {
  assert.deepEqual(typed.text, [{ selector: "#note", copy: "typed for the clip", matched: 1 }]);
  assert.equal(typed.frames.captured, plain.frames.captured);
  assert.notDeepEqual(typed.frames.hashes, plain.frames.hashes);
});

/**
 * A selector matching nothing means the clip shows the site's own wording where
 * the Action declared other wording, which is the one outcome worse than not
 * recording at all.
 */
test("a selector that matches nothing fails the Run, naming the selector", async () => {
  const { stderr, code } = await record(workspace, "run", "demo", "missing");

  assert.equal(code, 1);
  assert.match(stderr, /the text override '#nothing-like-it' matched nothing in the page/);
});

test("a selector the page cannot read fails the Run the same way", async () => {
  const { stderr, code } = await record(workspace, "run", "demo", "unreadable");

  assert.equal(code, 1);
  assert.match(stderr, /the text override '#\(' is not a selector the page understands/);
});

/**
 * An Action declaring copy that is not copy is refused while the module is
 * read, so it costs a message rather than a browser.
 */
test("copy that is not copy is refused before anything is recorded", async () => {
  await actionIn(workspace, "demo", "muddled", declaring(peek, { "#heading": 4 }));

  const { stderr, code } = await record(workspace, "parameters", "demo", "muddled");

  assert.equal(code, 1);
  assert.match(stderr, /text overrides for '#heading' must be the copy to substitute in/);
});
