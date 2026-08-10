/**
 * The Timeline evaluation seam, from the end an Action sees it: a pure function
 * from an Action and its effective Parameters to a per-Frame list of page
 * states, with no browser anywhere near it.
 *
 * Which value an Action runs with -- its own default, or an Override laid over
 * the top (ADR 0005) -- is decided here too, so that a wrong answer costs a
 * millisecond rather than a recording.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { allParameters, effectiveParameters, overrideFrom, type Action } from "../src/action.js";
import { RecordError } from "../src/errors.js";
import { motion } from "../src/motion.js";
import { evaluateTimeline } from "../src/timeline.js";

const parameters = {
  distance: {
    kind: "number",
    describes: "How far down the page travels, in CSS pixels",
    default: 100,
    min: 0,
    max: 1000,
  },
  travel: {
    kind: "number",
    describes: "How long the travel takes, in milliseconds",
    default: 500,
    min: 100,
    max: 5000,
  },
  framerate: { kind: "number", describes: "Frames per second", default: 10, min: 1, max: 120 },
  easing: { kind: "easing", describes: "How the travel settles", default: "linear" },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ distance, travel, framerate, easing }) {
    return motion({ framerate }).hold(200).scrollTo(distance, { durationMs: travel, easing });
  },
};

/** The page state of every Frame the Action produces under the given Overrides. */
function scrolls(overrides: Record<string, number | string> = {}): number[] {
  const effective = effectiveParameters(peek.parameters, overrides);

  return evaluateTimeline(peek.timeline(effective.values)).map((frame) => frame.scrollTop);
}

test("an Action and its effective Parameters decide every Frame's page state", () => {
  // 200ms of Hold then 500ms of travel, at 10fps.
  assert.deepEqual(scrolls(), [0, 0, 0, 20, 40, 60, 80]);
});

test("the effective Parameters are what the Action declares, under the names it declared them", () => {
  assert.deepEqual(effectiveParameters(peek.parameters), {
    values: { distance: 100, travel: 500, framerate: 10, easing: "linear" },
    overridden: [],
    warnings: [],
  });
});

/**
 * Every Run draws its own cursor, composites a Mockup around the Frames and
 * encodes a GIF as well as the video Artifacts (ADR 0006), and all three are
 * tunable per Action. None of them is motion, so an Action declares none of
 * them -- it carries them, and tuning one is the same act as tuning a distance.
 */
test("every Action carries the cursor, Mockup and Artifact Parameters as well as the ones it declares", () => {
  const declared = allParameters(peek);

  assert.deepEqual(Object.keys(declared), [
    "distance",
    "travel",
    "framerate",
    "easing",
    "cursor",
    "cursorStyle",
    "cursorCaptions",
    "mockup",
    "gifWidth",
    "gifFramerate",
  ]);

  const effective = effectiveParameters(declared);

  assert.equal(effective.values["cursor"], "auto");
  assert.equal(effective.values["cursorStyle"], "soft-dot");
  assert.equal(effective.values["cursorCaptions"], false);
  assert.equal(effective.values["mockup"], "auto");
  assert.equal(effective.values["gifWidth"], 640);
  assert.equal(effective.values["gifFramerate"], 20);
  assert.deepEqual(effective.warnings, []);
});

/**
 * ...and the Mockup is the one of them whose default is not a constant: a
 * Mockup is chosen for a Project, and an Action carries that choice as the
 * default an Override replaces.
 */
test("the Mockup an Action carries defaults to the one its Project chose", () => {
  const declared = allParameters(peek, { mockup: "laptop" });

  assert.equal(effectiveParameters(declared).values["mockup"], "laptop");
  assert.equal(effectiveParameters(declared, { mockup: "none" }).values["mockup"], "none");
});

/**
 * A Parameter reaches whoever tunes it as the control its kind describes, so a
 * choice is one of a named set and a flag is on or off -- neither is a number
 * box with a convention written down beside it.
 */
test("a choice and a flag are overridden by name and by true or false", () => {
  const declared = allParameters(peek);

  const chosen = effectiveParameters(declared, { cursor: "shown", cursorCaptions: true });

  assert.equal(chosen.values["cursor"], "shown");
  assert.equal(chosen.values["cursorCaptions"], true);
  assert.deepEqual(chosen.overridden, ["cursor", "cursorCaptions"]);
  assert.deepEqual(chosen.warnings, []);

  assert.equal(overrideFrom(declared, "cursorStyle", "arrow-light"), "arrow-light");
  assert.equal(overrideFrom(declared, "cursorCaptions", "true"), true);

  assert.throws(
    () => overrideFrom(declared, "cursor", "sometimes"),
    /'cursor' takes one of auto, shown, hidden, not 'sometimes'/,
  );
  assert.throws(
    () => overrideFrom(declared, "cursorCaptions", "yes"),
    /'cursorCaptions' takes true or false, not 'yes'/,
  );
});

test("a choice or flag Override of the wrong shape falls back to the default, saying so", () => {
  const declared = allParameters(peek);

  const wrong = effectiveParameters(declared, { cursorStyle: "squiggle", cursorCaptions: 1 });

  assert.equal(wrong.values["cursorStyle"], "soft-dot");
  assert.equal(wrong.values["cursorCaptions"], false);
  assert.deepEqual(wrong.overridden, []);
  assert.match(wrong.warnings[0] ?? "", /is 'squiggle', which is not one of soft-dot/);
  assert.match(wrong.warnings[1] ?? "", /is '1', which is not true or false/);
});

test("a choice defaulting to something outside its own choices fails naming the Parameter", () => {
  assert.throws(
    () =>
      effectiveParameters({
        shape: { kind: "choice", describes: "Which shape", default: "oval", choices: ["round"] },
      }),
    (failure: Error) => {
      assert.ok(failure instanceof RecordError);
      assert.match(failure.message, /'shape' defaults to 'oval', which is not one of round/);
      return true;
    },
  );
});

test("an Artifact Parameter is tuned by Override like any other", () => {
  const effective = effectiveParameters(allParameters(peek), { gifWidth: 480 });

  assert.equal(effective.values["gifWidth"], 480);
  assert.deepEqual(effective.overridden, ["gifWidth"]);
});

/**
 * Shadowing would leave two declarations of one name and no way to say which
 * an Override meant, so the Action is refused rather than quietly losing.
 */
test("an Action declaring a Parameter every Action already carries is refused by name", () => {
  const clashes = (parameters: Action["parameters"], expected: RegExp) => {
    const clashing: Action = { parameters, timeline: () => motion({ framerate: 10 }).hold(100) };

    assert.throws(() => allParameters(clashing), (failure: Error) => {
      assert.ok(failure instanceof RecordError);
      assert.match(failure.message, expected);
      return true;
    });
  };

  clashes(
    { gifWidth: { kind: "number", describes: "How wide", default: 300, min: 100, max: 900 } },
    /'gifWidth' is carried by every Action already/,
  );
  clashes(
    { cursorStyle: { kind: "choice", describes: "Which cursor", default: "mine", choices: ["mine"] } },
    /'cursorStyle' is carried by every Action already/,
  );
});

test("a Parameter defaulting outside its own range fails naming the Parameter", () => {
  assert.throws(
    () =>
      effectiveParameters({
        distance: { kind: "number", describes: "How far", default: 4000, min: 0, max: 1000 },
      }),
    (failure: Error) => {
      assert.ok(failure instanceof RecordError);
      assert.match(failure.message, /'distance' defaults to 4000, outside its own range 0\.\.1000/);
      return true;
    },
  );
});

test("an Override replaces the declared default, and says which Parameter it replaced", () => {
  const effective = effectiveParameters(peek.parameters, { distance: 240, easing: "ease-in-cubic" });

  assert.equal(effective.values.distance, 240);
  assert.equal(effective.values.easing, "ease-in-cubic");
  assert.equal(effective.values.travel, 500, "an untouched Parameter keeps its default");
  assert.deepEqual(effective.overridden, ["distance", "easing"]);
  assert.deepEqual(effective.warnings, []);
});

test("an Override changes the Frames the Action produces", () => {
  assert.deepEqual(scrolls({ distance: 200 }), [0, 0, 0, 40, 80, 120, 160]);
});

/**
 * Tuning outlives the code it was tuning. A sidecar naming a Parameter a
 * rewritten Action no longer declares costs a line of output rather than the
 * Run -- but it is never passed over in silence, because an Override that
 * quietly does nothing is worse than one that fails.
 */
test("an Override naming a Parameter the Action no longer declares is reported", () => {
  const effective = effectiveParameters(peek.parameters, { distance: 240, wobble: 3 });

  assert.equal(effective.values.distance, 240);
  assert.deepEqual(effective.overridden, ["distance"]);
  assert.deepEqual(effective.warnings, [
    "Override 'wobble' names a Parameter this Action no longer declares",
  ]);
});

test("an Override the declaration will not take falls back to the default, and says so", () => {
  const outOfRange = effectiveParameters(peek.parameters, { distance: 4000 });

  assert.equal(outOfRange.values.distance, 100);
  assert.deepEqual(outOfRange.overridden, []);
  assert.deepEqual(outOfRange.warnings, [
    "Override 'distance' is 4000, outside the declared range 0..1000, so the declared default is used instead",
  ]);

  const notANumber = effectiveParameters(peek.parameters, { distance: "quite far" });

  assert.equal(notANumber.values.distance, 100);
  assert.match(notANumber.warnings[0] ?? "", /is 'quite far', which is not a number/);

  const noSuchEasing = effectiveParameters(peek.parameters, { easing: "ease-in-quartic" });

  assert.equal(noSuchEasing.values.easing, "linear");
  assert.match(noSuchEasing.warnings[0] ?? "", /which is not one of linear, ease-in-cubic/);
});

/**
 * A value being set is the one moment the person setting it is listening, so
 * this is where a bad one is refused rather than warned about.
 */
test("an Override is checked against the declaration as it is set", () => {
  assert.equal(overrideFrom(peek.parameters, "distance", "240"), 240);
  assert.equal(overrideFrom(peek.parameters, "easing", "ease-out-cubic"), "ease-out-cubic");

  const refuses = (name: string, value: string, expected: RegExp) =>
    assert.throws(() => overrideFrom(peek.parameters, name, value), expected, `${name}=${value}`);

  refuses("wobble", "3", /'wobble' is not a Parameter this Action declares/);
  refuses("distance", "4000", /takes a number between 0 and 1000, not 4000/);
  refuses("distance", "far", /takes a number, not 'far'/);
  refuses("distance", "", /takes a number, not ''/);
  refuses("easing", "springy", /takes one of linear, ease-in-cubic/);
});
