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
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { fixtureSiteCommand, freePort, startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { RunReport } from "@record/core";

import { actionIn, record, removeWorkspaces, workspaceWith } from "./harness.js";

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
    stopped: project(`http://127.0.0.1:${startedPort}/`, {
      startCommand: fixtureSiteCommand({ port: startedPort, delayMs: comesUpAfterMs }),
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
  extras: { startCommand?: string; readyTimeoutMs?: number } = {},
): string {
  return [
    `base_url = "${baseUrl}"`,
    `source_repository = "."`,
    "video_width = 320",
    ...(extras.startCommand === undefined ? [] : [`start_command = ${JSON.stringify(extras.startCommand)}`]),
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
  assert.equal(reused.lifecycle.stopped, false);
  assert.equal(reused.lifecycle.readyUrl, site.url);

  assert.equal((await fetch(site.url)).status, 200, "the Run stopped a site it did not start");
});

/**
 * The other half: a Project that was not answering is started from its command,
 * waited for, recorded, and stopped again -- so the machine is left as it was
 * found in this direction too.
 */
test("a Project that is not answering is started, recorded, and stopped again", async () => {
  assert.equal(started.lifecycle.started, true);
  assert.equal(started.lifecycle.stopped, true);
  assert.equal(started.lifecycle.readyUrl, `http://127.0.0.1:${startedPort}/`);
  assert.equal(started.frames.hashes.length, started.frames.captured);

  assert.deepEqual(
    (await readdir(join(workspace, "runs", "stopped", "peek"))).sort(),
    ["peek.embed.html", "peek.gif", "peek.mp4", "peek.webm"],
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
 * must not be able to take it away. Here the Project is reconfigured out from
 * under an Action that already has Artifacts: the Run fails before it captures
 * anything, and every byte of the last good Run is still where it was.
 */
test("a Run that fails leaves the previous Latest Artifacts exactly as they were", async () => {
  const produced = join(workspace, "runs", "stopped", "peek");
  const before = await contentsOf(produced);
  assert.equal(Object.keys(before).length, 4);

  await writeFile(
    join(workspace, "projects", "stopped", "project.toml"),
    project(`http://127.0.0.1:${silentPort}/`),
    "utf8",
  );

  const { code } = await record(workspace, "run", "stopped", "peek");

  assert.equal(code, 1);
  assert.deepEqual(await contentsOf(produced), before);
});

/** Every file a Run left behind, by name, hashed rather than read into the assertion. */
async function contentsOf(directory: string): Promise<Record<string, string>> {
  const files = await readdir(directory);

  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(directory, file)))
          .digest("hex"),
      ]),
    ),
  );
}

/** Whether anything is serving at a URL, asked the way the tool asks it. */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return response.status < 400;
  } catch {
    return false;
  }
}
