/**
 * The CLI seam. Almost all behaviour is asserted here, through the same
 * command a person or an agent would type.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import { record, removeWorkspaces, workspaceWith } from "./harness.js";

after(removeWorkspaces);

const fullyConfigured = `
base_url = "http://127.0.0.1:4173/"
ready_path = "/health"
ready_timeout_ms = 15000
start_command = "npm run preview"
working_directory = 'C:\\demo\\site'
source_repository = 'C:\\demo\\site'
video_width = 960
mockup = "laptop"
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
      readyTimeoutMs: 15000,
      sourceRepository: "C:\\demo\\site",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      videoWidth: 960,
      mockup: "laptop",
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
      readyTimeoutMs: 60000,
      sourceRepository: "C:\\demo\\other",
      // One pixel of Frame per CSS pixel: a scale factor is four times the
      // pixels through the slowest part of a Run, so it is asked for.
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      videoWidth: 1280,
      // Nothing said about a surround is the browser window the page asks for.
      mockup: "auto",
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

test("an option belonging to another command fails rather than being ignored", async () => {
  const workspace = await workspaceWith({ demo: fullyConfigured });

  for (const [given, refused] of [
    [["status", "--progress"], /only run takes --progress/],
    [["run", "--all", "--port", "8080"], /only serve takes --port/],
    [["serve", "demo"], /serve takes no arguments/],
  ] as const) {
    const { stderr, code } = await record(workspace, ...given);

    assert.equal(code, 1, given.join(" "));
    assert.match(stderr, refused);
  }
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
