/**
 * Configuring a Project, at the CLI seam.
 *
 * The app owns configuration and reaches it through these commands, so what is
 * asserted here is what the app can do: a setting changed in the file it is
 * already written in, notes and formatting and all; a setting the tool will not
 * take refused while the file still says what it said; and a new Project that
 * arrives valid and not Published.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ProjectConfig, ProjectReport } from "@record/core";

import { projectIn, record, removeWorkspaces, workspaceWith } from "./harness.js";

after(removeWorkspaces);

/** A Project configured the way a person writes one: with notes in it. */
const commented = `# The demo site, as this tool records it.

base_url = "http://127.0.0.1:4173/"
ready_path = "/health"
source_repository = "."

# Started only when the site is not already answering.
start_command = "npm run preview"

# This one shows real content, so it stays off -- ADR 0007.
published = false

[viewport]
width = 1280
height = 720  # the size the design was drawn at
`;

const settingsOf = (reported: ProjectReport): Map<string, unknown> =>
  new Map(reported.settings.map((setting) => [setting.name, setting.value]));

test("`configure --json` reports every setting, and which of them the file says", async () => {
  const workspace = await workspaceWith({ demo: commented });

  const { stdout, code } = await record(workspace, "configure", "demo", "--json");
  const reported = JSON.parse(stdout) as ProjectReport;

  assert.equal(code, 0);
  assert.equal(reported.project, "demo");
  assert.equal(reported.file, join(workspace, "projects", "demo", "project.toml"));
  assert.deepEqual(reported.configured, JSON.parse((await record(workspace, "projects", "--json")).stdout)[0]);

  const settings = settingsOf(reported);

  assert.equal(settings.get("base_url"), "http://127.0.0.1:4173/");
  assert.equal(settings.get("viewport.height"), 720);
  // What the tool stands in where the file is silent, said as what the Project
  // will record with rather than left out.
  assert.equal(settings.get("video_width"), 1280);
  assert.equal(settings.get("working_directory"), null);

  const written = new Map(reported.settings.map((setting) => [setting.name, setting.written]));

  assert.equal(written.get("viewport.height"), true);
  assert.equal(written.get("video_width"), false);
});

/**
 * The whole point of editing in place: a Project's file is hand-written, and an
 * edit made through the app leaves every note in it exactly where it was.
 */
test("a setting is changed where it is written, and the comments survive", async () => {
  const workspace = await workspaceWith({ demo: commented });

  const { stdout, code } = await record(
    workspace,
    "configure",
    "demo",
    "base_url=http://127.0.0.1:9000/",
    "viewport.height=900",
    "video_width=960",
    "--json",
  );

  assert.equal(code, 0);

  const text = await readFile(join(workspace, "projects", "demo", "project.toml"), "utf8");

  assert.equal(
    text,
    `# The demo site, as this tool records it.

base_url = "http://127.0.0.1:9000/"
ready_path = "/health"
source_repository = "."

# Started only when the site is not already answering.
start_command = "npm run preview"

# This one shows real content, so it stays off -- ADR 0007.
published = false
video_width = 960

[viewport]
width = 1280
height = 900  # the size the design was drawn at
`,
  );

  // ...and the answer is what the Project will now record with, read back from
  // the file rather than assumed from what was asked for.
  const settings = settingsOf(JSON.parse(stdout) as ProjectReport);

  assert.equal(settings.get("base_url"), "http://127.0.0.1:9000/");
  assert.equal(settings.get("viewport.height"), 900);
  assert.equal(settings.get("video_width"), 960);
});

/**
 * A `project.toml` written on this machine has its lines ended the way Windows
 * ends them, and a setting has to be found on a line whichever way it ends --
 * one that is not found is written a second time, and a Project cannot be read
 * with the same key in it twice.
 */
test("a setting is changed in a file whose lines end the way this machine ends them", async () => {
  const workspace = await workspaceWith({});
  await projectIn(
    workspace,
    "demo",
    ['base_url = "http://127.0.0.1:4173/"', 'source_repository = "."', "published = false", ""].join(
      "\r\n",
    ),
  );

  const { stdout, code } = await record(workspace, "configure", "demo", "published=true", "--json");

  assert.equal(code, 0);
  assert.equal((JSON.parse(stdout) as ProjectReport).configured.published, true);
  assert.equal(
    await readFile(join(workspace, "projects", "demo", "project.toml"), "utf8"),
    ['base_url = "http://127.0.0.1:4173/"', 'source_repository = "."', "published = true", ""].join(
      "\r\n",
    ),
  );
});

/**
 * A Project's file is hand-written, so it can hold TOML no setting of this
 * tool's is written as. None of it is understood and none of it is touched: an
 * edit rewrites the one line its key is on and leaves the document alone.
 */
test("TOML this tool never writes is left exactly as it was found", async () => {
  const workspace = await workspaceWith({});
  const written = [
    'base_url = "http://127.0.0.1:4173/"',
    'source_repository = "."',
    "notes = '''",
    "published = never",
    "video_width = 1",
    "'''",
    "",
    "[[whatever]]",
    "width = 4",
    "",
    "[viewport]",
    "width = 1280",
    "",
  ].join("\n");

  await projectIn(workspace, "demo", written);

  const { code } = await record(workspace, "configure", "demo", "viewport.width=800");

  assert.equal(code, 0);
  assert.equal(
    await readFile(join(workspace, "projects", "demo", "project.toml"), "utf8"),
    written.replace("width = 1280", "width = 800"),
  );
});

/**
 * A table written on one line is not one this changes a key at a time, and
 * saying so beats declaring it a second time and refusing the Project that
 * would leave.
 */
test("a table written on one line is refused in words that say where to look", async () => {
  const workspace = await workspaceWith({
    demo: 'base_url = "http://127.0.0.1:4173/"\nsource_repository = "."\nviewport = { width = 1280 }\n',
  });

  const { stderr, code } = await record(workspace, "configure", "demo", "viewport.width=800");

  assert.equal(code, 1);
  assert.match(stderr, /'viewport' is written as one line of this document/);
});

test("a setting the file does not have yet is written into the table it belongs to", async () => {
  const workspace = await workspaceWith({
    demo: 'base_url = "http://127.0.0.1:4173/"\nsource_repository = "."\n',
  });

  await record(
    workspace,
    "configure",
    "demo",
    "mockup=laptop",
    "viewport.width=800",
    "viewport.device_scale_factor=1",
  );

  const { stdout } = await record(workspace, "configure", "demo", "--json");
  const reported = JSON.parse(stdout) as ProjectReport;
  const settings = settingsOf(reported);

  assert.equal(settings.get("mockup"), "laptop");
  assert.equal(settings.get("viewport.width"), 800);
  assert.equal(settings.get("viewport.device_scale_factor"), 1);

  // ...and a Project whose file says nothing about publishing is not Published,
  // which is the standing answer rather than one anybody wrote down.
  const published = reported.settings.find((setting) => setting.name === "published");

  assert.deepEqual({ value: published?.value, written: published?.written }, {
    value: false,
    written: false,
  });
  assert.equal(reported.configured.published, false);
  assert.match(
    await readFile(join(workspace, "projects", "demo", "project.toml"), "utf8"),
    /\[viewport]\nwidth = 800\ndevice_scale_factor = 1/,
  );
});

test("the publish toggle is set per Project, and is what `projects` then says", async () => {
  const workspace = await workspaceWith({ demo: commented });

  const { stdout, code } = await record(workspace, "configure", "demo", "published=true", "--json");

  assert.equal(code, 0);
  assert.equal((JSON.parse(stdout) as ProjectReport).configured.published, true);
  assert.match(await readFile(join(workspace, "projects", "demo", "project.toml"), "utf8"), /published = true/);
  assert.match((await record(workspace, "projects")).stdout, /demo {2}http:\/\/127\.0\.0\.1:4173\/ {2}published/);
});

/**
 * A setting emptied is a setting taken out of the file, and what the tool
 * stands in stands again -- which is how an optional one is put back rather
 * than written as nothing.
 */
test("an optional setting is emptied, and the standing value stands again", async () => {
  const workspace = await workspaceWith({ demo: commented });

  const { stdout, code } = await record(workspace, "configure", "demo", "start_command=", "--json");
  const reported = JSON.parse(stdout) as ProjectReport;

  assert.equal(code, 0);
  assert.equal(settingsOf(reported).get("start_command"), null);
  assert.equal(reported.configured.startCommand, undefined);

  const text = await readFile(join(workspace, "projects", "demo", "project.toml"), "utf8");

  assert.doesNotMatch(text, /start_command/);
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:4173\/"/);
});

test("a setting the Project cannot record without is changed rather than emptied", async () => {
  const workspace = await workspaceWith({ demo: commented });

  const { stderr, code } = await record(workspace, "configure", "demo", "base_url=");

  assert.equal(code, 1);
  assert.match(stderr, /'base_url' is one a Project cannot record without/);
});

/**
 * Refused rather than written: a setting that would fail at record time has to
 * fail here, while the file still says what it said and the message can say
 * what to send instead.
 */
test("a setting the tool will not take is refused, and the file is left as it was", async () => {
  const workspace = await workspaceWith({ demo: commented });
  const file = join(workspace, "projects", "demo", "project.toml");

  for (const [given, refused] of [
    ["base_url=not a url", /is not a URL, so nothing could be recorded at it/],
    ["base_url=ftp://127.0.0.1/", /recorded over http or https/],
    ["ready_path=health", /begins with \//],
    ["viewport.width=0", /takes a number between 1 and 7680/],
    ["viewport.width=12.5", /counts in whole numbers/],
    ["ready_timeout_ms=nine", /takes a number/],
    ["mockup=hologram", /takes one of auto, none/],
    ["published=maybe", /takes true or false/],
    ["working_directory=C:\\nowhere-at-all", /there is nothing at/],
    ["colour=blue", /is not a setting a Project has/],
    ["base_url", /a setting is written name=value/],
  ] as const) {
    const { stderr, code } = await record(workspace, "configure", "demo", given);

    assert.equal(code, 1, `'${given}' was not refused`);
    assert.match(stderr, refused);
    assert.equal(await readFile(file, "utf8"), commented);
  }
});

test("configuring a Project that is not there says so rather than writing one", async () => {
  const workspace = await workspaceWith({ demo: commented });

  const { stderr, code } = await record(workspace, "configure", "ghost", "published=true");

  assert.equal(code, 1);
  assert.match(stderr, /no Project named 'ghost' is configured/);
});

test("a new Project is configured, and it is not Published", async () => {
  const workspace = await workspaceWith({});

  const { stdout, code } = await record(
    workspace,
    "add",
    "fresh",
    `base_url=http://127.0.0.1:4173/`,
    `source_repository=${workspace}`,
    "mockup=phone",
    "--json",
  );

  assert.equal(code, 0);

  const reported = JSON.parse(stdout) as ProjectReport;

  assert.equal(reported.configured.published, false);
  assert.equal(reported.configured.mockup, "phone");
  assert.equal(reported.file, join(workspace, "projects", "fresh", "project.toml"));
  assert.match(await readFile(reported.file, "utf8"), /published = false/);

  // Configured means configured: the Project the other commands read is this
  // one, and it declares no Actions yet rather than failing to be read.
  const listed = JSON.parse((await record(workspace, "projects", "--json")).stdout) as ProjectConfig[];

  assert.deepEqual(
    listed.map((project) => project.name),
    ["fresh"],
  );
  assert.deepEqual(JSON.parse((await record(workspace, "actions", "fresh", "--json")).stdout), []);
});

test("a new Project says what it cannot be configured without", async () => {
  const workspace = await workspaceWith({});

  const { stderr, code } = await record(workspace, "add", "fresh", "mockup=phone");

  assert.equal(code, 1);
  assert.match(stderr, /base_url and source_repository at the least/);
  assert.deepEqual(JSON.parse((await record(workspace, "projects", "--json")).stdout), []);
});

test("a new Project is never Published, however the request is written", async () => {
  const workspace = await workspaceWith({});

  const { stderr, code } = await record(
    workspace,
    "add",
    "fresh",
    "base_url=http://127.0.0.1:4173/",
    `source_repository=${workspace}`,
    "published=true",
  );

  assert.equal(code, 1);
  assert.match(stderr, /a new Project is never Published/);
  assert.deepEqual(JSON.parse((await record(workspace, "projects", "--json")).stdout), []);
});

/**
 * A Project is named for the directory it is configured in, so a name that is a
 * path is refused: nothing is ever written outside the workspace's projects/.
 */
test("a name that is not a directory name configures nothing", async () => {
  const workspace = await workspaceWith({ demo: commented });

  for (const name of ["../escape", "with/slash", ".hidden", ""]) {
    const { stderr, code } = await record(
      workspace,
      "add",
      name,
      "base_url=http://127.0.0.1:4173/",
      `source_repository=${workspace}`,
    );

    assert.equal(code, 1, `'${name}' was not refused`);
    assert.match(stderr, /is not a name one can have|add takes a name for the new Project/);
  }

  assert.deepEqual(
    (JSON.parse((await record(workspace, "projects", "--json")).stdout) as ProjectConfig[]).map(
      (project) => project.name,
    ),
    ["demo"],
  );
});

test("a Project already configured is not configured over", async () => {
  const workspace = await workspaceWith({ demo: commented });

  const { stderr, code } = await record(
    workspace,
    "add",
    "demo",
    "base_url=http://127.0.0.1:4173/",
    `source_repository=${workspace}`,
  );

  assert.equal(code, 1);
  assert.match(stderr, /a Project named 'demo' is already configured/);
  assert.equal(
    await readFile(join(workspace, "projects", "demo", "project.toml"), "utf8"),
    commented,
  );
});

test("a Project whose file is not valid TOML says so rather than being written over", async () => {
  const workspace = await workspaceWith({});
  await projectIn(workspace, "broken", 'base_url = "http://127.0.0.1:4173/\n');

  const { stderr, code } = await record(workspace, "configure", "broken", "published=true");

  assert.equal(code, 1);
  assert.match(stderr, /is not valid TOML/);
});
