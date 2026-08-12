/**
 * Publishing, asserted at the CLI seam.
 *
 * Publishing is the only irreversible, outward-facing thing the tool does, so
 * what is asserted here is mostly what it does *not* do: that a Project which is
 * not Published is in neither the plan nor the directory, that run history never
 * leaves this machine, that nothing at all happens until it is confirmed, and
 * that the only repository written to is this one (ADR 0007).
 *
 * The repositories are throwaway ones this test builds -- the workspace it
 * publishes, a bare one to push to, and a Project's own repository that must
 * come out of this untouched. None of them is any repository on this machine.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { startFixtureSite, type FixtureSite } from "@record/fixture-site";
import type { PublishPlan, PublishReport, RunReport } from "@record/core";

import { actionIn, contentsOf, record, removeWorkspaces, workspaceWith } from "./harness.js";

const execute = promisify(execFile);

/** Four Frames of nothing much: what is under test is what becomes of them. */
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

let site: FixtureSite;
let workspace: string;
/** Where this workspace pushes to, which is the only place a publish ever pushes. */
let remote: string;
/** A Project's own repository, which publishing must leave exactly as it found it. */
let source: string;
/** The directories this test made, removed however it ends. */
const made: string[] = [];

/** The Latest of the Published Project, and of the Project that is not. */
let latest: RunReport;
let unpublished: RunReport;
/** The Latest of one Matrix Condition, which keeps a history of its own. */
let dark: RunReport;

before(async () => {
  site = await startFixtureSite();
  source = await throwawayRepository();
  remote = await bareRepository();

  workspace = await workspaceWith({
    demo: project(site.url, source, true),
    // Published is off unless it is deliberately turned on, so this one says
    // nothing about it at all -- which is how a real Project arrives.
    vault: project(site.url, source, false),
  });

  await actionIn(workspace, "demo", "peek", peek);
  await actionIn(workspace, "demo", "unrecorded", peek);
  await actionIn(workspace, "vault", "peek", peek);

  await repositoryFor(workspace);

  latest = await recordRun("demo", "peek");
  unpublished = await recordRun("vault", "peek");

  // A Run older than the Latest, and one Condition's Latest: what publishing
  // takes of each history is the newest of it and nothing behind it.
  await seedRun(latest, { at: new Date("2020-01-01T00:00:00.000Z"), name: "peek" });
  dark = await seedRun(latest, {
    at: new Date("2020-01-02T00:00:00.000Z"),
    name: "peek-dark",
    condition: "dark",
  });
}, { timeout: 300_000 });

after(async () => {
  await site.close();
  await removeWorkspaces();
  await Promise.all(made.splice(0).map((one) => rm(one, { recursive: true, force: true })));
});

/** A Project pointed at the fixture site, which is already answering and stays so. */
function project(baseUrl: string, sourceRepository: string, published: boolean): string {
  return [
    `base_url = "${baseUrl}"`,
    `source_repository = ${JSON.stringify(sourceRepository)}`,
    "video_width = 320",
    'mockup = "none"',
    ...(published ? ["published = true"] : []),
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

async function publishing(...args: string[]): Promise<PublishReport> {
  const { stdout, stderr, code } = await record(workspace, "publish", ...args, "--json");
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as PublishReport;
}

/** Every file a plan would make public, by where it would land. */
function pathsOf(plan: PublishPlan): string[] {
  return plan.files.map((file) => file.path).sort();
}

/**
 * A Run of an Action older or otherwise apart from the one just recorded, made
 * by copying what a real Run produced rather than by recording again -- each Run
 * is a browser and an encoder, and what is under test here is which of them
 * publishing reaches for.
 */
async function seedRun(
  from: RunReport,
  seeded: { readonly at: Date; readonly name: string; readonly condition?: string },
): Promise<RunReport> {
  // Named for the instant it began, exactly as a Run names its own directory.
  const id = seeded.at.toISOString().replaceAll(":", "-").replace(".", "-");
  const under = seeded.condition === undefined ? [] : ["conditions", seeded.condition];
  const directory = join(workspace, "runs", from.project, from.action, ...under, id);

  await mkdir(directory, { recursive: true });

  const artifacts = await Promise.all(
    from.artifacts.map(async (artifact) => {
      const path = join(directory, `${seeded.name}.${artifact.format}`);
      await copyFile(artifact.path, path);

      return { ...artifact, path };
    }),
  );

  const report: RunReport = {
    ...from,
    id,
    recordedAt: seeded.at.toISOString(),
    directory,
    artifacts,
    embed: join(directory, `${seeded.name}.embed.html`),
    ...(seeded.condition === undefined
      ? {}
      : { condition: { name: seeded.condition, scheme: "dark", width: null, switched: "emulated" } }),
  };

  await writeFile(join(directory, "run.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(report.embed, "<video></video>", "utf8");

  return report;
}

/**
 * This repository, as the test builds it: one commit, and somewhere to push to.
 * Only the files it is handed are ever added, since a workspace also holds the
 * package it resolves `@record/core` through.
 */
async function repositoryFor(directory: string): Promise<void> {
  await git(directory, "init", "--initial-branch=main");
  await git(directory, "config", "user.email", "tests@record.invalid");
  await git(directory, "config", "user.name", "record tests");
  await git(directory, "config", "commit.gpgsign", "false");
  await git(directory, "remote", "add", "origin", remote);

  await writeFile(join(directory, "README.md"), "the workspace, as a repository\n", "utf8");
  await git(directory, "add", "--", "README.md");
  await git(directory, "commit", "--message", "the workspace as it was before publishing");
  await git(directory, "push", "--set-upstream", "origin", "main");
}

/**
 * A Project's own repository, with a commit in it and an edit that was never
 * committed. Publishing must leave both exactly as they are.
 */
async function throwawayRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "record-source-"));
  made.push(directory);

  await git(directory, "init", "--initial-branch=main");
  await git(directory, "config", "user.email", "tests@record.invalid");
  await git(directory, "config", "user.name", "record tests");
  await git(directory, "config", "commit.gpgsign", "false");

  await writeFile(join(directory, "one.txt"), "the Project as it was recorded", "utf8");
  await git(directory, "add", "--", "one.txt");
  await git(directory, "commit", "--message", "write one.txt");

  await writeFile(join(directory, "uncommitted.txt"), "work in progress", "utf8");

  return directory;
}

async function bareRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "record-remote-"));
  made.push(directory);

  await git(directory, "init", "--bare", "--initial-branch=main");

  return directory;
}

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", directory, ...args]);
  return stdout.trim();
}

async function headOf(directory: string): Promise<string> {
  return git(directory, "rev-parse", "HEAD");
}

/** What one commit changed, by path -- which is what "this repository only" comes to. */
async function changedBy(directory: string, commit: string): Promise<string[]> {
  const said = await git(directory, "show", "--name-only", "--format=", commit);

  return said.split("\n").filter((line) => line !== "").sort();
}

/**
 * What a publish would make public: the Latest Artifacts of the Published
 * Project, at the paths they would be linked by, with the size of each.
 */
test("`publish --dry-run --json` emits the plan: files, sizes and Projects", async () => {
  const published = await publishing("--dry-run");
  const { plan } = published;

  assert.equal(published.published, false);
  assert.equal(plan.directory, "published");

  assert.deepEqual(pathsOf(plan), [
    "published/demo/peek/peek-dark.gif",
    "published/demo/peek/peek-dark.mp4",
    "published/demo/peek/peek-dark.webm",
    "published/demo/peek/peek.gif",
    "published/demo/peek/peek.mp4",
    "published/demo/peek/peek.webm",
  ]);

  // The size of each is the size it really is on this machine, since it is what
  // somebody deciding whether to make it public is deciding about.
  for (const file of plan.files) {
    assert.equal(file.bytes, (await stat(file.from)).size, file.path);
  }
  assert.equal(
    plan.bytes,
    plan.files.reduce((total, file) => total + file.bytes, 0),
  );

  // ...and which Projects, said as Projects rather than left to be read off the
  // paths: an Action's Latest, and the Latest of each of its Conditions.
  assert.deepEqual(
    plan.projects.map((one) => one.project),
    ["demo"],
  );
  assert.deepEqual(
    plan.projects[0]?.actions.map((one) => [one.action, one.condition, one.recordedAt]),
    [
      ["peek", null, latest.recordedAt],
      ["peek", "dark", dark.recordedAt],
    ],
  );
});

/** The Latest is the newest Run of a history, and everything behind it is history. */
test("only the Latest of each history is published, never the Runs behind it", async () => {
  const { plan } = await publishing("--dry-run");

  for (const file of plan.files) {
    assert.equal(file.from.startsWith(join(workspace, "runs")), true, file.from);
  }

  assert.deepEqual(
    [...new Set(plan.files.map((file) => basename(file.from)))].sort(),
    ["peek-dark.gif", "peek-dark.mp4", "peek-dark.webm", "peek.gif", "peek.mp4", "peek.webm"],
  );

  const seeded = join(workspace, "runs", "demo", "peek", "2020-01-01T00-00-00-000Z");
  assert.equal(
    plan.files.some((file) => file.from.startsWith(seeded)),
    false,
    "a Run older than the Latest is not published",
  );
});

/**
 * Run history is never published (ADR 0007). It exists on this machine to
 * support judging a Run against the one before it, and the record a Run leaves
 * of itself says where on this machine every Frame of it came from.
 */
test("run history is never published", async () => {
  const { plan } = await publishing("--dry-run");

  for (const file of plan.files) {
    assert.doesNotMatch(file.path, /run\.json$/);
    assert.doesNotMatch(file.path, /2020-01-0/, "no Run's own directory is published");
  }
});

/**
 * The whole of what the setting means: a Project that is not Published keeps its
 * Artifacts on this machine, however many Runs of it there are.
 */
test("a Project that is not Published is in neither the plan nor the directory", async () => {
  const { plan } = await publishing("--dry-run");

  assert.equal(
    plan.projects.some((one) => one.project === "vault"),
    false,
  );
  assert.equal(
    plan.files.some((file) => file.path.includes("vault") || file.from.includes("vault")),
    false,
  );
  assert.equal(
    plan.files.some((file) => file.from === unpublished.artifacts[0]?.path),
    false,
    "the unpublished Project has a Latest, and it stays on this machine",
  );
});

/** Asked without saying which, publishing says what it would do and does none of it. */
test("`publish` without --confirm is the same plan, and nothing is written", async () => {
  const before = await headOf(workspace);

  const asked = await publishing();
  const dryRun = await publishing("--dry-run");

  assert.deepEqual(asked, dryRun);
  assert.equal(asked.published, false);
  assert.equal(asked.commit, null);
  assert.equal(asked.pushed, false);

  assert.deepEqual(await readdir(join(workspace, "published")).catch(() => null), null);
  assert.equal(await headOf(workspace), before);
});

test("a plan says so in words as well, naming every file and what it weighs", async () => {
  const { stdout, code } = await record(workspace, "publish");

  assert.equal(code, 0);
  assert.match(stdout, /published\/demo\/peek\/peek\.mp4/);
  assert.match(stdout, /6 files from demo/);
  assert.match(stdout, /nothing has been published.*--confirm/);
});

/** Opposite requests: one shows what would happen and the other makes it happen. */
test("--dry-run and --confirm together are refused rather than guessed at", async () => {
  const { stderr, code } = await record(workspace, "publish", "--dry-run", "--confirm");

  assert.equal(code, 1);
  assert.match(stderr, /one or the other/);
});

test("publish makes every Published Project public, so it takes no Project", async () => {
  const { stderr, code } = await record(workspace, "publish", "demo");

  assert.equal(code, 1);
  assert.match(stderr, /takes no Project/);
});

test("an option belonging to publish is refused on any other command", async () => {
  for (const given of [
    ["status", "--confirm"],
    ["projects", "--dry-run"],
  ] as const) {
    const { stderr, code } = await record(workspace, ...given);

    assert.equal(code, 1, given.join(" "));
    assert.match(stderr, /only publish takes --/);
  }
});

/**
 * Confirmed, it carries out exactly the plan it showed: the same files at the
 * same paths, byte for byte what the Latest produced.
 */
test("`publish --confirm` copies the planned files into the tracked directory", async () => {
  const planned = await publishing("--dry-run");
  const published = await publishing("--confirm");

  assert.equal(published.published, true);
  assert.deepEqual(pathsOf(published.plan), pathsOf(planned.plan));

  const directory = join(workspace, "published");

  assert.deepEqual(
    Object.keys(await contentsOf(directory)).map((path) => path.replaceAll("\\", "/")).sort(),
    pathsOf(published.plan).map((path) => path.slice("published/".length)),
  );

  for (const file of published.plan.files) {
    assert.deepEqual(
      await readFile(join(workspace, ...file.path.split("/"))),
      await readFile(file.from),
      `${file.path} is the Artifact it says it is`,
    );
  }
});

/**
 * ADR 0007: this repository and nothing else. The commit names the published
 * directory alone, so work sitting uncommitted elsewhere in it is not swept up
 * by a button pressed without thinking -- and the Project's own repository is
 * neither committed to nor touched at all.
 */
test("only this repository is committed to and pushed, and only its published directory", async () => {
  // Work of somebody else's, staged and unstaged, sitting in this repository
  // while the button is pressed.
  await writeFile(join(workspace, "notes.md"), "half-written\n", "utf8");
  await git(workspace, "add", "--", "notes.md");
  await writeFile(join(workspace, "README.md"), "edited and not committed\n", "utf8");

  const sourceHead = await headOf(source);
  const sourceStanding = await git(source, "status", "--porcelain");

  // Something to commit. Two Runs of an unchanged Action are the same bytes, so
  // recording again publishes nothing new -- tuning it is what changes the clip.
  const { stdout, stderr, code } = await record(
    workspace,
    "run",
    "demo",
    "peek",
    "--set",
    "framerate=12",
    "--json",
  );
  assert.equal(code, 0, stderr);

  const again = JSON.parse(stdout) as RunReport;
  assert.notEqual(again.id, latest.id);

  const published = await publishing("--confirm");

  assert.equal(published.published, true);
  assert.notEqual(published.commit, null);
  assert.equal(published.pushed, true);
  // As this repository stands rather than moved to a branch of its own, and it
  // says which branch, because that is where the clips now are.
  assert.equal(published.branch, "main");

  const commit = published.commit ?? "";

  assert.equal(await headOf(workspace), commit);
  for (const path of await changedBy(workspace, commit)) {
    assert.match(path, /^published\//, "the commit names the published directory alone");
  }

  // What was staged is still staged, and what was edited is still edited --
  // the leading space of the first line is lost to trimming, and ' M' is still
  // not 'M ', which is the distinction being asserted.
  const standing = await git(workspace, "status", "--porcelain");
  assert.match(standing, /^A {2}notes\.md$/m, standing);
  assert.match(standing, /^ ?M README\.md$/m, standing);

  // The one repository that is pushed is this one, and it really was.
  assert.equal(await git(remote, "rev-parse", "HEAD"), commit);

  // ...and the Project's own repository is exactly as it was: not read from for
  // this, not written to, not committed to, not pushed.
  assert.equal(await headOf(source), sourceHead);
  assert.equal(await git(source, "status", "--porcelain"), sourceStanding);
});

/** Publishing what is already public is not a failure and not a second commit. */
test("publishing again when nothing has changed commits nothing", async () => {
  const before = await headOf(workspace);

  const published = await publishing("--confirm");

  assert.equal(published.published, true);
  assert.equal(published.commit, null);
  assert.equal(published.pushed, false);
  assert.equal(await headOf(workspace), before);
});

/**
 * The other direction of the toggle, which is the one that matters: a Project
 * that stops being Published is a clip that stops being public, so publishing
 * takes it back out rather than leaving it where it is.
 */
test("a Project that stops being Published has its clips taken out of the directory", async () => {
  const { code } = await record(workspace, "configure", "demo", "published=false");
  assert.equal(code, 0);

  const planned = await publishing("--dry-run");

  assert.deepEqual(planned.plan.files, []);
  assert.deepEqual(
    [...planned.plan.removing].sort(),
    [
      "published/demo/peek/peek-dark.gif",
      "published/demo/peek/peek-dark.mp4",
      "published/demo/peek/peek-dark.webm",
      "published/demo/peek/peek.gif",
      "published/demo/peek/peek.mp4",
      "published/demo/peek/peek.webm",
    ],
  );

  const published = await publishing("--confirm");

  assert.notEqual(published.commit, null);
  assert.deepEqual(await readdir(join(workspace, "published")).catch(() => null), null);

  for (const path of await changedBy(workspace, published.commit ?? "")) {
    assert.match(path, /^published\//);
  }

  await record(workspace, "configure", "demo", "published=true");
});

/**
 * A Published Project with nothing recorded is not a failure: it is a Project
 * whose clips are about to exist. Said out loud, because "published nothing" and
 * "published everything it had" read the same in a plan of no files.
 */
test("a Published Project with no Run to publish is warned about rather than failing", async () => {
  const { stdout, stderr, code } = await record(workspace, "publish", "--dry-run", "--json");

  assert.equal(code, 0);

  const { plan } = JSON.parse(stdout) as PublishReport;

  assert.equal(
    plan.warnings.some((said) => said.includes("'demo'")),
    false,
    "a Project with a Latest is not warned about",
  );

  // A Project that is Published and has recorded nothing at all.
  const { code: configured } = await record(workspace, "configure", "vault", "published=true");
  assert.equal(configured, 0);
  await rm(join(workspace, "runs", "vault"), { recursive: true, force: true });

  const empty = await publishing("--dry-run");

  assert.equal(
    empty.plan.warnings.some((said) => said.includes("'vault'") && said.includes("no Run")),
    true,
    `nothing said about a Published Project with no Run: ${empty.plan.warnings.join(", ")}`,
  );
  assert.equal(
    empty.plan.files.some((file) => file.path.includes("vault")),
    false,
  );

  await record(workspace, "configure", "vault", "published=false");
});

/**
 * Copying into a directory this repository ignores would succeed at every step
 * and make nothing public -- which, on the one irreversible operation here,
 * reads exactly like having published. It is refused before anything is copied.
 */
test("a repository ignoring the published directory is refused rather than published into", async () => {
  const ignoring = join(workspace, ".gitignore");
  await writeFile(ignoring, "published/\n", "utf8");

  const planned = await publishing("--dry-run");

  assert.equal(
    planned.plan.warnings.some((said) => said.includes("ignored")),
    true,
    `nothing said about an ignored directory: ${planned.plan.warnings.join(", ")}`,
  );

  const { stderr, code } = await record(workspace, "publish", "--confirm");

  assert.equal(code, 1);
  assert.match(stderr, /ignored by this repository/);
  assert.deepEqual(
    await readdir(join(workspace, "published")).catch(() => null),
    null,
    "and nothing was copied into it on the way to finding out",
  );

  await rm(ignoring, { force: true });
});
