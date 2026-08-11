/**
 * The app, asserted at the CLI seam.
 *
 * The app has no seam of its own for the same reason the server has none: it
 * holds no recording logic, and everything it shows is an answer the `record`
 * command gave. What is assertable from outside is therefore what this server
 * serves of it -- the page the tool is opened at, the modules that page loads,
 * and the fact that the package it lives in is not otherwise readable over
 * loopback. What the modules then draw is held to by `pnpm build`.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { record, removeWorkspaces, serving, workspaceWith, type ServedRecord } from "./harness.js";

/** A Project nothing here records: the app is served whatever the workspace holds. */
const demo = ['base_url = "http://127.0.0.1:1/"', 'source_repository = "."', ""].join("\n");

let workspace: string;
let server: ServedRecord;

before(async () => {
  workspace = await workspaceWith({ demo });
  server = await serving(workspace);
});

after(async () => {
  await server.close();
  await removeWorkspaces();
});

/**
 * Opening the server is opening the app. A shortcut has one URL to open and no
 * way to be told a second one, so the tool has to be at the root of it.
 */
test("the app is served at the address the command says it is serving at", async () => {
  const response = await fetch(server.url);
  const page = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(page, /<div id="app"/);
  assert.match(page, /<script type="module" src="\.\/dist\/src\/main\.js">/);
  assert.match(page, /<link rel="stylesheet" href="\.\/app\.css"/);
});

test("the modules and stylesheet the page loads are served as what they are", async () => {
  const script = await fetch(new URL("dist/src/main.js", server.url));
  const styles = await fetch(new URL("app.css", server.url));

  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await script.text(), /paint/);

  assert.equal(styles.status, 200);
  assert.equal(styles.headers.get("content-type"), "text/css; charset=utf-8");
});

/**
 * The app is a package like any other: a manifest, a tsconfig and the TypeScript
 * the modules were compiled from all sit beside it. None of those are the app,
 * and a server that offered them would be serving its own source to a page.
 */
test("nothing in the app's package but the app is served", async () => {
  for (const path of ["package.json", "tsconfig.json", "src/main.ts"]) {
    const response = await fetch(new URL(path, server.url));

    assert.equal(response.status, 404, `${path} answered ${response.status}`);
  }
});

test("nothing outside the app is served, however a path is spelled", async () => {
  for (const path of ["../package.json", "dist/%2e%2e/%2e%2e/package.json", "%2e%2e%2fpackage.json"]) {
    const response = await fetch(new URL(path, server.url));

    assert.ok([403, 404].includes(response.status), `${path} answered ${response.status}`);
    assert.doesNotMatch(await response.text(), /"name": "record"/, `${path} served a file outside`);
  }
});

/**
 * The app asks for the same answers over the same API anything else would, and
 * the endpoints are read at `/api` now that the root of the server is the app.
 */
test("the API says what it offers beside the app, and answers the app's own requests", async () => {
  const offered = (await (await fetch(new URL("api", server.url))).json()) as {
    workspace: string;
    endpoints: string[];
  };

  assert.equal(offered.workspace, workspace);
  assert.ok(offered.endpoints.includes("GET  /api/projects"));

  const { stdout } = await record(workspace, "projects", "--json");
  const projects = await (await fetch(new URL("api/projects", server.url))).json();

  assert.deepEqual(projects, JSON.parse(stdout));
});
