/**
 * Project lifecycle, asserted at the CLI seam.
 *
 * The claim being tested is the one that costs an operator their afternoon if it
 * is wrong: a Project that was already answering is the one they were using, so
 * a Run borrows it and gives it back. Only a Project this tool started is ever
 * stopped, and that is asserted by asking the Projects themselves afterwards
 * rather than by reading anything the tool says about itself.
 */
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  fixtureSiteCommand,
  fixtureSiteDirectory,
  freePort,
  startFixtureSite,
  type FixtureSite,
} from "@record/fixture-site";
import type { RunReport } from "@record/core";

import { actionIn, contentsOf, record, removeWorkspaces, workspaceWith } from "./harness.js";

/** Four Frames of nothing much. What is under test here is the Project, not the clip. */
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

/** An Action that fails on its own terms, so that a Project failure can be told from one. */
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

/** Long enough to prove the tool waits for the ready URL rather than the command returning. */
const comesUpAfterMs = 400;

/** Short enough that the Project which never comes up does not hold the suite up. */
const givesUpAfterMs = 2_000;

let site: FixtureSite;
let workspace: string;
/** The port the Project this tool starts serves on, once it has been started. */
let startedPort: number;
/** The port nothing ever answers on. */
let silentPort: number;

/** The Run against a Project that was already answering, and the Run that started one. */
let reused: RunReport;
let started: RunReport;

before(async () => {
  site = await startFixtureSite();
  startedPort = await freePort();
  silentPort = await freePort();

  workspace = await workspaceWith({
    running: project(site.url),
    // The command names its script relatively, so a working_directory that
    // never reached the shell is a Project that never starts.
    stopped: project(`http://127.0.0.1:${startedPort}/`, {
      startCommand: fixtureSiteCommand({ port: startedPort, delayMs: comesUpAfterMs }),
      workingDirectory: fixtureSiteDirectory,
    }),
    unreachable: project(`http://127.0.0.1:${silentPort}/`),
    // A command that runs and keeps running, and never serves anything.
    silent: project(`http://127.0.0.1:${silentPort}/`, {
      startCommand: `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`,
      readyTimeoutMs: givesUpAfterMs,
    }),
    nowhere: project("not a URL at all"),
  });

  for (const name of ["running", "stopped", "unreachable", "silent", "nowhere"]) {
    await actionIn(workspace, name, "peek", peek);
  }
  await actionIn(workspace, "running", "impossible", impossible);

  reused = await recordRun("running", "peek");
  started = await recordRun("stopped", "peek");
}, { timeout: 300_000 });

after(async () => {
  await site.close();
  await removeWorkspaces();
});

/** One Project's configuration, differing only in how it is reached and started. */
function project(
  baseUrl: string,
  extras: { startCommand?: string; workingDirectory?: string; readyTimeoutMs?: number } = {},
): string {
  return [
    `base_url = "${baseUrl}"`,
    `source_repository = "."`,
    "video_width = 320",
    'mockup = "none"',
    ...(extras.startCommand === undefined ? [] : [`start_command = ${JSON.stringify(extras.startCommand)}`]),
    ...(extras.workingDirectory === undefined
      ? []
      : [`working_directory = ${JSON.stringify(extras.workingDirectory)}`]),
    ...(extras.readyTimeoutMs === undefined ? [] : [`ready_timeout_ms = ${extras.readyTimeoutMs}`]),
    "",
    "[viewport]",
    "width = 400",
    "height = 300",
    "device_scale_factor = 1",
    "",
  ].join("\n");
}

async function recordRun(project: string, action: string): Promise<RunReport> {
  const { stdout, stderr, code } = await record(workspace, "run", project, action, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as RunReport;
}

/**
 * A Project already answering is almost certainly the one the operator has open,
 * so a Run leaves it exactly as it found it. That the site is still serving after
 * the Run is the assertion; what the Run says about itself is only corroboration.
 */
test("a Project already answering is recorded as it stands and left running", async () => {
  assert.equal(reused.lifecycle.started, false);
  assert.equal(reused.lifecycle.readyUrl, site.url);

  const answered = await fetch(site.url);
  await answered.body?.cancel();

  assert.equal(answered.status, 200, "the Run stopped a site it did not start");
});

/**
 * The other half: a Project that was not answering is started from its command
 * and its working directory, waited for, recorded, and stopped again -- so the
 * machine is left as it was found in this direction too.
 */
test("a Project that is not answering is started, recorded, and stopped again", async () => {
  assert.equal(started.lifecycle.started, true);
  assert.equal(started.lifecycle.readyUrl, `http://127.0.0.1:${startedPort}/`);
  assert.equal(started.frames.hashes.length, started.frames.captured);

  assert.deepEqual(
    (await readdir(started.directory)).sort(),
    ["peek.embed.html", "peek.gif", "peek.mp4", "peek.webm", "run.json"],
  );

  assert.equal(await answers(`http://127.0.0.1:${startedPort}/`), false, "the Project it started is still up");
});

/** Recording it is the point: a Project started for a Run is a Project that recorded. */
test("the Project this tool started recorded the same site as one that was already up", () => {
  assert.deepEqual(started.frames.hashes, reused.frames.hashes);
});

test("a Project that is not answering and cannot be started fails naming both", async () => {
  const { stderr, code } = await record(workspace, "run", "unreachable", "peek");

  assert.equal(code, 1);
  assert.match(stderr, /Project 'unreachable'/);
  assert.match(stderr, new RegExp(`127\\.0\\.0\\.1:${silentPort}`));
  assert.match(stderr, /start_command/);
});

test("a Project whose base_url is not a URL fails naming the Project rather than throwing", async () => {
  const { stderr, code } = await record(workspace, "run", "nowhere", "peek");

  assert.equal(code, 1);
  assert.match(stderr, /Project 'nowhere' cannot be reached/);
  assert.doesNotMatch(stderr, /at Object|node:internal/, "an operator's mistake kept a stack");
});

/**
 * A Project that never comes up and an Action that waits for something that
 * never happens are different failures with different fixes, so they read
 * differently: one names the Project and where it was waited for, the other
 * names what the Action was waiting on.
 */
test("a Project that never becomes ready fails distinguishably from an Action that fails", async () => {
  const ofProject = await record(workspace, "run", "silent", "peek");

  assert.equal(ofProject.code, 1);
  assert.match(ofProject.stderr, /Project 'silent'/);
  assert.match(ofProject.stderr, new RegExp(`127\\.0\\.0\\.1:${silentPort}`));
  assert.doesNotMatch(ofProject.stderr, /Action/);

  const ofAction = await record(workspace, "run", "running", "impossible");

  assert.equal(ofAction.code, 1);
  assert.match(ofAction.stderr, /the Action waited for a thing that never happens/);
  assert.doesNotMatch(ofAction.stderr, /Project/);
});

/**
 * Latest is what the UI shows and what Publishing copies, so a Run that fails
 * must not be able to take it away -- neither one that fails part-way through
 * recording, with Frames already on disk, nor one that never gets that far.
 * Both are put to the Action that already has Artifacts here, and every byte of
 * the last good Run is still where it was after each.
 */
test("a Run that fails leaves the previous Latest Artifacts exactly as they were", async () => {
  const produced = join(workspace, "runs", "stopped", "peek");
  const latest = await contentsOf(produced);
  assert.equal(Object.keys(latest).length, 5);

  // Recording gets as far as the browser and then fails on the Action's terms.
  await actionIn(workspace, "stopped", "peek", impossible);
  const whileRecording = await record(workspace, "run", "stopped", "peek");

  assert.equal(whileRecording.code, 1);
  assert.deepEqual(await contentsOf(produced), latest);
  assert.equal(
    await answers(`http://127.0.0.1:${startedPort}/`),
    false,
    "a Run that failed left the Project it started running",
  );

  // ...and the Project is reconfigured out from under the Action, so that the
  // second failure happens before anything is recorded at all.
  await writeFile(
    join(workspace, "projects", "stopped", "project.toml"),
    project(`http://127.0.0.1:${silentPort}/`),
    "utf8",
  );
  const beforeRecording = await record(workspace, "run", "stopped", "peek");

  assert.equal(beforeRecording.code, 1);
  assert.deepEqual(await contentsOf(produced), latest);
});

/**
 * Whether anything is serving at a URL. Deliberately the test's own probe
 * rather than the tool's: what is being asserted is what became of a server,
 * which is worth nothing if it is asked with the code under test.
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
