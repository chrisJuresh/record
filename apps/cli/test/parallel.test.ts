/**
 * Recording many Actions at once, asserted at the CLI seam.
 *
 * The premise is ADR 0001's: a Run's output depends on the stepped clock rather
 * than on wall-clock time, so however hard the Actions recording beside it are
 * working the machine, the Frames are the ones the Timeline declared. That is
 * asserted rather than argued -- the Artifacts of Actions recorded at once are
 * compared byte for byte against the same Actions recorded one at a time.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  fixtureSiteCommand,
  fixtureSiteDirectory,
  freePort,
  startFixtureSite,
  type FixtureSite,
} from "@record/fixture-site";
import type { RunReport, RunSummary } from "@record/core";

import {
  actionIn,
  artifactsOf,
  projectIn,
  record,
  removeWorkspaces,
  workspaceWith,
  type CommandResult,
} from "./harness.js";

/**
 * Four Frames of a page travelling a declared distance. Every Action here is
 * one of these with a distance of its own, so that Artifacts belonging to two
 * Actions can be told apart.
 */
function peek(distance: number): string {
  return `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 10, min: 1, max: 120 },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate }).hold(100).scrollTo(${distance}, { durationMs: 200 }).hold(100);
  },
};

export default peek;
`;
}

/** An Action that fails on its own terms, so the others have something to survive. */
const impossible = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 10, min: 1, max: 120 },
} as const;

const impossible: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate })
      .hold(100)
      .waitFor("false", { durationMs: 200, describes: "a thing that never happens" });
  },
};

export default impossible;
`;

/** The Actions of the Project that is already answering, and how far each travels. */
const travels = { one: 40, three: 120, two: 80 };

/** How often the two startable Projects are asked whether they are answering. */
const pollIntervalMs = 50;

let site: FixtureSite;

/** The workspace whose Project is already answering, and is only ever recorded. */
let recorded: string;
/** The workspace whose Projects the tool has to start for itself. */
let started: string;

/** Each Action of the answering Project, recorded on its own. */
const alone: Record<string, RunReport> = {};
/** The same Actions, recorded at once, and what the command said about it. */
let together: RunSummary;
let togetherSaid: CommandResult;

/** Where the Projects the tool starts for itself answer. */
let alphaUrl: string;
let betaUrl: string;

/** What recording every startable Project produced, and what was watched while it did. */
type Everything = {
  readonly summary: RunSummary;
  /** Whether the two Projects were ever answering at the same moment. */
  readonly bothUp: boolean;
  /** How many times each Project's start command ran. */
  readonly starts: Record<string, number>;
};

/** Recording both startable Projects one Action at a time, and several at once. */
let serial: Everything;
let concurrent: Everything;

before(async () => {
  site = await startFixtureSite();

  recorded = await workspaceWith({
    demo: answeringProject(site.url),
    // Configured and given no Actions: a Project with nothing to record is not
    // a Project that fails to record.
    empty: answeringProject(site.url),
  });
  for (const [action, distance] of Object.entries(travels)) {
    await actionIn(recorded, "demo", action, peek(distance));
  }
  await actionIn(recorded, "demo", "impossible", impossible);

  for (const action of Object.keys(travels)) {
    alone[action] = await recordOne(recorded, action);
  }

  togetherSaid = await record(recorded, "run", "demo", "--json");
  together = JSON.parse(togetherSaid.stdout) as RunSummary;

  started = await workspaceWith({});
  const [alphaPort, betaPort] = [await freePort(), await freePort()];
  alphaUrl = `http://127.0.0.1:${alphaPort}/`;
  betaUrl = `http://127.0.0.1:${betaPort}/`;

  await startableProject(started, "alpha", alphaPort);
  await startableProject(started, "beta", betaPort);
  // Two Actions of one Project, so that a Project started once for both can be
  // told from one started for each.
  await actionIn(started, "alpha", "first", peek(40));
  await actionIn(started, "alpha", "second", peek(80));
  await actionIn(started, "beta", "only", peek(40));

  serial = await recordEverything("--concurrency", "1");
  concurrent = await recordEverything();
}, { timeout: 600_000 });

after(async () => {
  await site.close();
  await removeWorkspaces();
});

/** A Project pointed at the fixture site, which is answering already. */
function answeringProject(baseUrl: string): string {
  return [
    `base_url = "${baseUrl}"`,
    `source_repository = "."`,
    "video_width = 320",
    "",
    "[viewport]",
    "width = 400",
    "height = 300",
    "device_scale_factor = 1",
    "",
  ].join("\n");
}

/**
 * A Project the tool has to start for itself, whose start command leaves a line
 * behind every time it runs. How many lines there are is the whole of how a
 * Project started once for its Actions is told from one started for each.
 */
async function startableProject(workspace: string, name: string, port: number): Promise<void> {
  const marker = join(workspace, `${name}.starts`);
  const script = join(workspace, `${name}-starting.mjs`);

  await writeFile(marker, "", "utf8");
  await writeFile(
    script,
    [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync(${JSON.stringify(marker)}, "started\\n");`,
      "",
    ].join("\n"),
    "utf8",
  );

  await projectIn(
    workspace,
    name,
    [
      `base_url = "http://127.0.0.1:${port}/"`,
      `source_repository = "."`,
      "video_width = 320",
      `start_command = ${JSON.stringify(`"${process.execPath}" "${script}" && ${fixtureSiteCommand({ port })}`)}`,
      `working_directory = ${JSON.stringify(fixtureSiteDirectory)}`,
      "",
      "[viewport]",
      "width = 400",
      "height = 300",
      "device_scale_factor = 1",
      "",
    ].join("\n"),
  );
}

async function recordOne(workspace: string, action: string): Promise<RunReport> {
  const { stdout, stderr, code } = await record(workspace, "run", "demo", action, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as RunReport;
}

/**
 * Records every Action of every startable Project, watching both of them from
 * outside the tool while it does. Whether two Projects were ever up at the same
 * moment is the only evidence of concurrency there is that does not depend on
 * how fast this machine happens to be.
 */
async function recordEverything(...options: string[]): Promise<Everything> {
  await Promise.all(
    ["alpha", "beta"].map((name) => writeFile(join(started, `${name}.starts`), "", "utf8")),
  );

  const recording = record(started, "run", "--all", ...options, "--json");
  const bothUp = await bothUpWhile(recording);

  const { stdout, stderr, code } = await recording;
  assert.equal(code, 0, stderr);

  return { summary: JSON.parse(stdout) as RunSummary, bothUp, starts: await timesStarted() };
}

/** Whether both startable Projects were ever answering at the same moment. */
async function bothUpWhile(recording: Promise<CommandResult>): Promise<boolean> {
  let running = true;
  void recording.then(() => {
    running = false;
  });

  let both = false;

  while (running) {
    const [alpha = false, beta = false] = await Promise.all([answers(alphaUrl), answers(betaUrl)]);
    both ||= alpha && beta;
    await delay(pollIntervalMs);
  }

  return both;
}

/** How many times each startable Project's start command has run. */
async function timesStarted(): Promise<Record<string, number>> {
  const counted = await Promise.all(
    ["alpha", "beta"].map(async (name) => {
      const marker = await readFile(join(started, `${name}.starts`), "utf8");
      return [name, marker.split("\n").filter((line) => line !== "").length] as const;
    }),
  );

  return Object.fromEntries(counted);
}

/**
 * Whether anything is serving at a URL. Deliberately the test's own probe
 * rather than the tool's: what is being asserted is what actually ran, which is
 * worth nothing if it is asked with the code under test.
 */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return response.status < 400;
  } catch {
    return false;
  }
}

/** What one Action recorded in a summary, or a failure naming the one that is missing. */
function runOf(summary: RunSummary, action: string): RunReport {
  const run = summary.runs.find((one) => one.action === action);
  assert.ok(run !== undefined, `nothing recorded '${action}'`);

  return run;
}

/**
 * The assertion the whole feature rests on. If this fails, recording many
 * Actions at once is not something this tool can honestly offer.
 */
test("Actions recorded at once produce the Artifacts they produce one at a time, byte for byte", async () => {
  for (const action of Object.keys(travels)) {
    const one = alone[action];
    assert.ok(one !== undefined, `'${action}' was never recorded on its own`);

    const many = runOf(together, action);

    assert.deepEqual(many.frames.hashes, one.frames.hashes, `the Frames of '${action}'`);
    assert.deepEqual(await artifactsOf(many), await artifactsOf(one), `the Artifacts of '${action}'`);
  }
});

/** ...and each Action recorded its own clip, rather than three copies of one. */
test("Actions recorded at once keep their own Artifacts apart", async () => {
  const hashed = await Promise.all(
    Object.keys(travels).map(async (action) => JSON.stringify(await artifactsOf(runOf(together, action)))),
  );

  assert.equal(new Set(hashed).size, hashed.length, "two Actions produced the same Artifacts");
});

/**
 * A Project of twenty Actions is not worth abandoning over the one that cannot
 * record, so the others are recorded regardless and the failure is named.
 */
test("one Action failing does not abandon the others, and the summary names what failed", () => {
  assert.deepEqual(
    together.failures.map((failure) => `${failure.project} ${failure.action}`),
    ["demo impossible"],
  );
  assert.match(together.failures[0]?.message ?? "", /the Action waited for a thing that never happens/);

  assert.deepEqual(
    together.runs.map((run) => run.action),
    ["one", "three", "two"],
    "every other Action recorded, in the order they were asked for",
  );

  // The command failed, and said which Action failed it, whichever output was
  // asked for -- a failure buried in JSON nobody read is a failure missed.
  assert.equal(togetherSaid.code, 1);
  assert.match(togetherSaid.stderr, /failed: demo impossible: /);
  assert.match(togetherSaid.stdout, /"failures"/);
});

test("a Project with no Actions records nothing rather than failing", async () => {
  const { stdout, code } = await record(recorded, "run", "empty", "--concurrency", "2", "--json");
  const summary = JSON.parse(stdout) as RunSummary;

  assert.equal(code, 0);
  assert.deepEqual(summary.runs, []);
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.concurrency, 2, "the concurrency asked for is the concurrency reported");
});

test("concurrency defaults to four", () => {
  assert.equal(together.concurrency, 4);
});

test("--concurrency takes a count of Actions and refuses anything else", async () => {
  for (const given of ["0", "-2", "2.5", "lots", ""]) {
    const { stderr, code } = await record(recorded, "run", "demo", "--concurrency", given);

    assert.equal(code, 1, `--concurrency ${given} was accepted`);
    assert.match(stderr, /--concurrency takes how many Actions record at once/);
  }
});

/**
 * Starting a Project per Action would be a second server fighting the first for
 * the port; stopping one per Action would stop it under the Actions still
 * recording. Both are ruled out by the start command having run exactly once
 * for the Project whose two Actions recorded against it.
 */
test("a Project needing to be started is started once and shared by its Actions", () => {
  assert.deepEqual(concurrent.starts, { alpha: 1, beta: 1 });
  assert.deepEqual(serial.starts, { alpha: 1, beta: 1 });

  for (const run of concurrent.summary.runs) {
    assert.equal(run.lifecycle.started, true, `${run.project} ${run.action}`);
  }
});

/**
 * The byte-for-byte comparison again, against the Projects the tool had to
 * start: recorded one at a time, and recorded at once against a Project two
 * Actions shared, the Artifacts are the same bytes either way.
 */
test("a Project the tool started records the same at once as it does one at a time", async () => {
  for (const action of ["first", "second", "only"]) {
    const one = runOf(serial.summary, action);
    const many = runOf(concurrent.summary, action);

    assert.deepEqual(many.frames.hashes, one.frames.hashes, `the Frames of '${action}'`);
    assert.deepEqual(await artifactsOf(many), await artifactsOf(one), `the Artifacts of '${action}'`);
  }
});

/**
 * Two Actions of one Project record beside each other rather than one after the
 * other -- measured against how far apart those same two Runs began when they
 * were recorded one at a time, so that nothing about how fast this machine
 * happens to be decides it.
 */
test("two Actions of one Project record at once rather than one after the other", () => {
  const apart = (recorded: Everything) =>
    Math.abs(
      Date.parse(runOf(recorded.summary, "second").recordedAt) -
        Date.parse(runOf(recorded.summary, "first").recordedAt),
    );

  assert.ok(
    apart(concurrent) * 2 < apart(serial),
    `began ${apart(concurrent)}ms apart at once, and ${apart(serial)}ms apart one at a time`,
  );
});

/** ...and the machine is left as it was found, however many Actions recorded. */
test("every Project this tool started is stopped once its Actions have recorded", async () => {
  assert.equal(await answers(alphaUrl), false, "the Project it started is still up");
  assert.equal(await answers(betaUrl), false, "the Project it started is still up");
});

/**
 * What `--concurrency` is for. One at a time is the direction worth asserting
 * from outside: two Projects up at the same moment would mean the cap was not a
 * cap at all, and nothing about how fast this machine is can produce that.
 */
test("--concurrency 1 records one Action at a time, and the default records several", () => {
  assert.equal(serial.bothUp, false, "two Projects were up at once under --concurrency 1");
  assert.equal(serial.summary.concurrency, 1);

  assert.equal(concurrent.bothUp, true, "no two Projects were ever up at once");
  assert.equal(concurrent.summary.concurrency, 4);
});

test("`run --all` records every Action of every Project", () => {
  assert.deepEqual(
    concurrent.summary.runs.map((run) => `${run.project} ${run.action}`).sort(),
    ["alpha first", "alpha second", "beta only"],
  );
  assert.deepEqual(concurrent.summary.failures, []);
});

test("`run --all` alongside a Project says which was meant rather than guessing", async () => {
  const { stderr, code } = await record(recorded, "run", "--all", "demo");

  assert.equal(code, 1);
  assert.match(stderr, /run --all records every Project, so it takes no Project/);
});

test("`run` with nothing to record names every form it takes", async () => {
  const { stderr, code } = await record(recorded, "run");

  assert.equal(code, 1);
  assert.match(stderr, /run takes a Project and one of its Actions, a Project, or --all/);
});

/** An Override belongs to one Action, so there is no saying which of many it meant. */
test("`--set` without an Action to set it on says so rather than tuning everything", async () => {
  const { stderr, code } = await record(recorded, "run", "demo", "--set", "framerate=5");

  assert.equal(code, 1);
  assert.match(stderr, /--set names one Action's Parameter/);
});

/** ...and asking for one Action at four at a time is asking for something else. */
test("`--concurrency` alongside one Action to record says so rather than being ignored", async () => {
  const { stderr, code } = await record(recorded, "run", "demo", "one", "--concurrency", "4");

  assert.equal(code, 1);
  assert.match(stderr, /--concurrency is how many Actions record at once/);
});
