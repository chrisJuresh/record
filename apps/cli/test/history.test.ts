/**
 * Run history and staleness, asserted at the CLI seam.
 *
 * Staleness is a claim about a Project's git repository, so the fixture here is
 * a throwaway repository built by the test rather than any Project on this
 * machine -- committing to a real one to watch an Action go Stale would be a
 * test that edits the thing it is measuring.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { ActionStatus, ProjectStatus, RunReport, StatusReport } from "@record/core";

import { actionIn, contentsOf, record, removeWorkspaces, workspaceWith } from "./harness.js";

const execute = promisify(execFile);

/** Four Frames of nothing much: what is under test is the record a Run leaves. */
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

/** What the tool keeps of each Action, and what the pruning test has to overflow. */
const retained = 10;

let site: FixtureSite;
/** The Project's own repository, which only this test ever commits to. */
let repository: string;
let workspace: string;
/** The repositories this test made, removed however it ends. */
const repositories: string[] = [];

/** The one Run every test but the pruning one reads. */
let first: RunReport;

before(async () => {
  site = await startFixtureSite();
  repository = await throwawayRepository();

  workspace = await workspaceWith({ demo: project(site.url, repository) });
  await actionIn(workspace, "demo", "peek", peek);
  await actionIn(workspace, "demo", "prune", peek);
  // Declared and never recorded, which is a different thing from Stale.
  await actionIn(workspace, "demo", "unrecorded", peek);

  first = await recordRun("peek");
}, { timeout: 300_000 });

after(async () => {
  await site.close();
  await removeWorkspaces();
  await Promise.all(repositories.splice(0).map((one) => rm(one, { recursive: true, force: true })));
});

/**
 * A Project pointed at the fixture site, whose source repository is the
 * throwaway one. Never started or stopped: the site is already answering.
 */
function project(baseUrl: string, sourceRepository: string): string {
  return [
    `base_url = "${baseUrl}"`,
    `source_repository = ${JSON.stringify(sourceRepository)}`,
    "video_width = 320",
    "",
    "[viewport]",
    "width = 400",
    "height = 300",
    "device_scale_factor = 1",
    "",
  ].join("\n");
}

async function recordRun(action: string): Promise<RunReport> {
  const { stdout, stderr, code } = await record(workspace, "run", "demo", action, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as RunReport;
}

async function statusOf(): Promise<StatusReport> {
  const { stdout, stderr, code } = await record(workspace, "status", "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as StatusReport;
}

/** What `status` says about one Action, or a failure naming the one it never mentioned. */
function statusOfAction(
  reported: StatusReport,
  action: string,
): { project: ProjectStatus; action: ActionStatus } {
  const project = reported.projects.find((one) => one.project === "demo");
  assert.ok(project !== undefined, "status reported no Project named 'demo'");

  const found = project.actions.find((one) => one.action === action);
  assert.ok(found !== undefined, `status reported no Action named '${action}'`);

  return { project, action: found };
}

/**
 * A Run keeps what it produced beside the conditions it was produced under, so
 * that a Run months old can still be told apart from the one beside it.
 */
test("a Run is kept with its timestamp, the Project's commit, its Parameters and its tools", async () => {
  assert.equal(first.directory, join(workspace, "runs", "demo", "peek", first.id));

  assert.deepEqual((await readdir(first.directory)).sort(), [
    "peek.embed.html",
    "peek.gif",
    "peek.mp4",
    "peek.webm",
    "run.json",
  ]);

  const kept = JSON.parse(await readFile(join(first.directory, "run.json"), "utf8")) as RunReport;

  assert.deepEqual(kept, first, "what a Run reported is what it kept");
  assert.equal(kept.commit, await headOf(repository));
  assert.equal(new Date(kept.recordedAt).toISOString(), kept.recordedAt);
  assert.deepEqual(kept.parameters, { framerate: 10, gifWidth: 640, gifFramerate: 20 });

  // The versions of the tools that actually made this clip: a Frame captured by
  // a different Chromium is a different Frame, and both are on this machine.
  assert.equal(kept.tools.node, process.version);
  assert.match(kept.tools.chrome ?? "", /\d+\.\d+/);
  assert.match(kept.tools.ffmpeg ?? "", /\d+\.\d+/);
});

test("`status --json` reports an Action whose Project has not been committed to since as current", async () => {
  const head = await headOf(repository);
  const { project, action } = statusOfAction(await statusOf(), "peek");

  assert.equal(project.commit, head);
  assert.equal(action.stale, false);
  assert.equal(action.runs, 1);
  assert.equal(action.lastRun?.id, first.id);
  assert.equal(action.lastRun?.commit, head);
});

/**
 * Deliberately not considered: a working tree is edited all day, and an Action
 * that went Stale every time a file was saved would be a flag nobody reads.
 */
test("uncommitted changes in a Project do not make its Actions Stale", async () => {
  await writeFile(join(repository, "one.txt"), "edited but not committed", "utf8");
  await writeFile(join(repository, "untracked.txt"), "never added at all", "utf8");

  const { action } = statusOfAction(await statusOf(), "peek");

  assert.equal(action.stale, false);
});

test("an Action whose Project has been committed to since it last ran is Stale", async () => {
  const before = await headOf(repository);
  await commitTo(repository, "two.txt", "a change worth re-recording");
  const head = await headOf(repository);

  assert.notEqual(head, before);

  const { project, action } = statusOfAction(await statusOf(), "peek");

  assert.equal(project.commit, head);
  assert.equal(action.stale, true);
  assert.equal(action.lastRun?.commit, before, "the Run still records the commit it recorded");
});

/** An Action nobody has recorded has nothing to be Stale against. */
test("an Action that has never run reports the absence rather than Staleness", async () => {
  const { action } = statusOfAction(await statusOf(), "unrecorded");

  assert.equal(action.lastRun, null);
  assert.equal(action.stale, false);
  assert.equal(action.runs, 0);
});

/**
 * Staleness is reported and never acted on. Asked twice with a Stale Action
 * sitting there, `status` leaves every byte of every retained Run where it was.
 */
test("reporting staleness never records anything", async () => {
  const kept = await contentsOf(join(workspace, "runs", "demo", "peek"));

  const { stdout, code } = await record(workspace, "status");

  assert.equal(code, 0);
  assert.match(stdout, /peek/);
  assert.match(stdout, /stale/);

  assert.deepEqual(await contentsOf(join(workspace, "runs", "demo", "peek")), kept);
});

/**
 * The tool must not be able to fill the disk, so a Run is kept only until ten
 * newer ones exist. Overflowing that by recording eleven times would be eleven
 * browsers and thirty-three encodes; the Runs being pruned are seeded instead,
 * and one real Run is what does the pruning.
 */
test("the ten most recent Runs of an Action are retained and older ones pruned", async () => {
  const directory = join(workspace, "runs", "demo", "prune");
  const seeded = await seedRuns(directory, 12);

  const newest = await recordRun("prune");

  const remaining = (await readdir(directory)).sort();
  assert.equal(remaining.length, retained);
  assert.deepEqual(remaining, [...seeded.slice(-(retained - 1)), newest.id].sort());

  const { stdout } = await record(workspace, "history", "demo", "prune", "--json");
  const history = JSON.parse(stdout) as RunReport[];

  assert.deepEqual(
    history.map((run) => run.id),
    [...remaining].reverse(),
    "history reads newest first",
  );
});

/**
 * Frames of a Project can contain anything that Project renders, and the
 * retained Runs are made of them, so the directory they live in is one this
 * repository never commits.
 */
test("Run history lives in a directory excluded from version control", async () => {
  const checkout = resolve(import.meta.dirname, "../../../..");

  const ignored = await execute("git", ["-C", checkout, "check-ignore", "runs"]).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );

  assert.equal(ignored, "runs", "runs/ is not ignored by this repository");
});

/**
 * A git repository belonging to this test alone, with one commit in it.
 *
 * Signing is turned off within it because a machine configured to sign every
 * commit would otherwise make this fixture ask for a key -- it says nothing
 * about how this repository's own commits are made.
 */
async function throwawayRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "record-source-"));
  repositories.push(directory);

  await git(directory, "init", "--initial-branch=main");
  await git(directory, "config", "user.email", "tests@record.invalid");
  await git(directory, "config", "user.name", "record tests");
  await git(directory, "config", "commit.gpgsign", "false");

  await commitTo(directory, "one.txt", "the Project as it was recorded");

  return directory;
}

async function commitTo(directory: string, file: string, contents: string): Promise<void> {
  await writeFile(join(directory, file), contents, "utf8");
  await git(directory, "add", file);
  await git(directory, "commit", "-m", `write ${file}`);
}

async function headOf(directory: string): Promise<string> {
  return git(directory, "rev-parse", "HEAD");
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", directory, ...args]);
  return stdout.trim();
}

/**
 * Runs of an Action older than anything this test records, so that a real Run
 * has something to prune. Their ids are returned oldest first, which is the
 * order pruning works against.
 */
async function seedRuns(directory: string, count: number): Promise<string[]> {
  const ids: string[] = [];

  for (let ago = count; ago >= 1; ago--) {
    const at = new Date(Date.now() - ago * 60_000);
    const id = at.toISOString().replaceAll(":", "-").replace(".", "-");

    await mkdir(join(directory, id), { recursive: true });
    await writeFile(
      join(directory, id, "run.json"),
      JSON.stringify({ ...first, id, recordedAt: at.toISOString(), directory: join(directory, id) }),
      "utf8",
    );

    ids.push(id);
  }

  return ids;
}
