/**
 * The CLI seam. Almost all behaviour is asserted here, through the same
 * command a person or an agent would type.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = resolve(import.meta.dirname, "../src/main.js");

const workspaces: string[] = [];
after(() => Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true }))));

type CommandResult = { stdout: string; stderr: string; code: number };

/** Runs the built `record` command against a workspace of the test's own. */
async function record(workspace: string, ...args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, RECORD_WORKSPACE: workspace },
    });
    return { stdout, stderr, code: 0 };
  } catch (failure) {
    const { stdout, stderr, code } = failure as CommandResult;
    return { stdout, stderr, code };
  }
}

/** A workspace holding the given Projects, each with the given `project.toml`. */
async function workspaceWith(projects: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "record-cli-"));
  workspaces.push(workspace);

  for (const [name, config] of Object.entries(projects)) {
    await mkdir(join(workspace, "projects", name), { recursive: true });
    await writeFile(join(workspace, "projects", name, "project.toml"), config, "utf8");
  }

  return workspace;
}

const fullyConfigured = `
base_url = "http://127.0.0.1:4173/"
ready_path = "/health"
start_command = "npm run preview"
working_directory = 'C:\\demo\\site'
source_repository = 'C:\\demo\\site'
published = true

[viewport]
width = 1280
height = 720
device_scale_factor = 1
`;

const minimallyConfigured = `
base_url = "http://127.0.0.1:5173/"
source_repository = 'C:\\demo\\other'
`;

test("`projects --json` reports every configured Project", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured });

  const { stdout, code } = await record(workspace, "projects", "--json");

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), [
    {
      name: "demo",
      baseUrl: "http://127.0.0.1:4173/",
      readyPath: "/health",
      startCommand: "npm run preview",
      workingDirectory: "C:\\demo\\site",
      sourceRepository: "C:\\demo\\site",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      published: true,
    },
  ]);
});

test("a Project that declares only what it must gets the defaults, and is not Published", async () => {
  const workspace = await workspaceWith({ other: minimallyConfigured });

  const { stdout } = await record(workspace, "projects", "--json");

  assert.deepEqual(JSON.parse(stdout), [
    {
      name: "other",
      baseUrl: "http://127.0.0.1:5173/",
      readyPath: "/",
      sourceRepository: "C:\\demo\\other",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      published: false,
    },
  ]);
});

test("`projects` names each Project and whether it is Published", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured, other: minimallyConfigured });

  const { stdout } = await record(workspace, "projects");

  assert.equal(
    stdout,
    ["demo   http://127.0.0.1:4173/  published", "other  http://127.0.0.1:5173/  not published", ""].join("\n"),
  );
});

test("a workspace with no Projects reports none rather than failing", async () => {
  const workspace = await workspaceWith({});

  const { stdout, code } = await record(workspace, "projects", "--json");

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), []);
});

test("a directory under projects/ holding no project.toml is not a Project", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured });
  await mkdir(join(workspace, "projects", "scratch"));

  const { stdout, code } = await record(workspace, "projects", "--json");

  assert.equal(code, 0);
  assert.deepEqual(
    (JSON.parse(stdout) as { name: string }[]).map((project) => project.name),
    ["demo"],
  );
});

test("an option the command does not have fails rather than being ignored", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured });

  const { stderr, code } = await record(workspace, "projects", "--jsonn");

  assert.equal(code, 1);
  assert.match(stderr, /unknown option '--jsonn'/);
});

test("an argument the command has no use for fails rather than being dropped", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured });

  const { stderr, code } = await record(workspace, "actions", "demo", "scroll-peek");

  assert.equal(code, 1);
  assert.match(stderr, /actions takes the name of one Project/);
});

test("`actions --json` reports a Project's Actions by name", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured });
  await mkdir(join(workspace, "projects", "demo", "actions"));
  await writeFile(join(workspace, "projects", "demo", "actions", "scroll-peek.ts"), "", "utf8");
  await writeFile(join(workspace, "projects", "demo", "actions", "open-lightbox.ts"), "", "utf8");
  await writeFile(join(workspace, "projects", "demo", "actions", "notes.md"), "", "utf8");

  const { stdout, code } = await record(workspace, "actions", "demo", "--json");

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), ["open-lightbox", "scroll-peek"]);
});

test("a Project with no Actions yet reports none rather than failing", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured });

  const { stdout, code } = await record(workspace, "actions", "demo", "--json");

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), []);
});

test("naming a Project that is not configured fails with a message saying so", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured });

  const { stderr, code } = await record(workspace, "actions", "missing");

  assert.equal(code, 1);
  assert.match(stderr, /no Project named 'missing'/);
});

test("a Project whose configuration is missing a required value fails naming the file and the value", async () => {
  const workspace = await workspaceWith({ broken: `ready_path = "/"\n` });

  const { stderr, code } = await record(workspace, "projects");

  assert.equal(code, 1);
  assert.match(stderr, /projects[\\/]broken[\\/]project\.toml/);
  assert.match(stderr, /base_url/);
});
