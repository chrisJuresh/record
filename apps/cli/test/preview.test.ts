/**
 * The Preview origin, asserted at the CLI seam.
 *
 * It is started the way anything else starts this server -- by running
 * `record serve` -- and then asked over HTTP. What is assertable from outside
 * is what the origin serves: a page carrying the driver, everything else
 * untouched, and a refusal for anything that is not the Project it was
 * allocated for.
 *
 * The fixture site is what it proxies, because a proxy has to keep a real site
 * working: this one serves several pages and references its stylesheet
 * absolutely, which is exactly the thing a root-mounted proxy has to get right.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as ask } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import type { TimelineReport } from "@record/core";
import { startFixtureSite, type FixtureSite } from "@record/fixture-site";

import {
  actionIn,
  record,
  removeWorkspaces,
  serving,
  workspaceWith,
  type ServedRecord,
} from "./harness.js";

/** An Action that only travels, which is what a Preview can drive. */
const peek = `
import { motion, type Action } from "@record/core";

const parameters = {
  distance: { kind: "number", describes: "how far the page travels", default: 200, min: 0, max: 2000 },
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ distance, framerate }) {
    return motion({ framerate })
      .hold(100)
      .scrollTo(distance, { durationMs: 400, easing: "linear" })
      .hold(100);
  },
};

export default peek;
`;

/** ...and one that would really do something to the site, which it cannot. */
const clicker = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
} as const;

const clicker: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate, startsAt: { scrollTop: 0, cursor: { x: 20, y: 20 } } })
      .hold(100)
      .click()
      .hold(100);
  },
};

export default clicker;
`;

let site: FixtureSite;
let workspace: string;
let server: ServedRecord;

/** Where the Project is proxied, allocated the first time a Preview is asked for. */
let origin: string;

before(async () => {
  site = await startFixtureSite();
  workspace = await workspaceWith({
    demo: [`base_url = "${site.url}"`, 'source_repository = "."', ""].join("\n"),
  });
  await actionIn(workspace, "demo", "peek", peek);
  await actionIn(workspace, "demo", "clicker", clicker);

  server = await serving(workspace);
  origin = (await turnedOn("demo", "peek")).origin;
});

after(async () => {
  await server.close();
  await site.close();
  await removeWorkspaces();
});

/**
 * What an Action's Timeline evaluates to is read over HTTP exactly as the
 * command answers it -- the app replays this and evaluates nothing of its own,
 * so a Preview cannot disagree with a Run about what an easing does.
 */
test("the evaluated Timeline over HTTP is exactly what the command says", async () => {
  const { stdout, code } = await record(workspace, "timeline", "demo", "peek", "--json");
  assert.equal(code, 0);

  assert.deepEqual(await read("api/timeline/demo/peek"), JSON.parse(stdout));
});

/**
 * ...and so is one read under values the person has not settled on, which is
 * what the app asks for while a slider is moving. Nothing is written by it.
 */
test("a value named in the query is evaluated as if it applied, and written nowhere", async () => {
  const scrubbed = await read<TimelineReport>("api/timeline/demo/peek?set=distance%3D400");

  assert.equal(scrubbed.states.at(-1)?.scrollTop, 400);
  assert.deepEqual(scrubbed.named, ["distance"]);

  const sidecar = join(workspace, "projects", "demo", "actions", "peek.overrides.toml");
  await assert.rejects(readFile(sidecar, "utf8"), /ENOENT/, "no Override was left behind");

  assert.deepEqual(
    await read("api/timeline/demo/peek"),
    JSON.parse((await record(workspace, "timeline", "demo", "peek", "--json")).stdout),
    "and the Action is tuned exactly as it was",
  );
});

/**
 * The reason the origin exists: the app cannot script a page served on the
 * Project's own port, so the page comes back through an origin the app owns,
 * carrying the driver that listens for where to scroll to.
 */
test("the Project's page comes back through the origin carrying the driver", async () => {
  const response = await fetch(origin);
  const page = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page, /<script data-record-preview>/);
  assert.match(page, /__recordScroller/, "which finds the scroller the way capture finds it");
  assert.match(page, /scroll-behavior:auto/, "and stops smooth scrolling the way capture does");

  // ...and the page is otherwise the page: a proxy that rewrote the site would
  // be previewing something nobody is going to record.
  assert.match(page, /<h1 id="heading">Fixture site<\/h1>/);
  assert.match(page, /<script data-record-preview>[\s\S]*<\/body>/, "put where the body ends");
});

test("everything that is not a page comes back untouched", async () => {
  const response = await fetch(new URL("styles.css", origin));
  const styles = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
  assert.doesNotMatch(styles, /data-record-preview/);
  assert.equal(
    styles,
    await readFile(
      resolve(import.meta.dirname, "../../../../packages/fixture-site/site/styles.css"),
      "utf8",
    ),
  );
});

/**
 * Root-mounted, so a path the site references absolutely resolves through the
 * origin exactly as it does on the site itself. A Preview of a page whose
 * stylesheet 404s is a Preview of a different page.
 */
test("a path the site references absolutely resolves through the origin", async () => {
  const page = await (await fetch(origin)).text();

  assert.match(page, /href="\/styles\.css"/, "the site references it absolutely");
  assert.equal((await fetch(new URL("/styles.css", origin))).status, 200);

  // ...and so does another of the site's own pages, which is what a Project
  // that navigates while it is being previewed would ask for.
  assert.equal((await fetch(new URL("/light.html", origin))).status, 200);
});

/**
 * This is a Preview of one Project, not a general proxy this tool has put on
 * the machine. A request naming another host is refused however it is spelled.
 */
test("the origin refuses anything that is not under the Project it serves", async () => {
  for (const path of ["http://example.com/", "//example.com/", "https://example.com/x"]) {
    const answered = await raw(origin, path);

    assert.equal(answered.status, 403, `${path} answered ${answered.status}`);
    assert.match(answered.body, /one Project/);
  }
});

test("the origin answers a loopback Host and nothing else", async () => {
  assert.equal((await raw(origin, "/", { host: "localhost" })).status, 200);
  assert.equal((await raw(origin, "/", { host: "records.example.com" })).status, 403);
});

/**
 * The origin is allocated once and kept. A Parameter change must not put a new
 * origin on this machine any more than it puts a new frame in the page -- the
 * app creates the iframe once and only ever messages it afterwards.
 */
test("asking for a Preview again is the same origin rather than another one", async () => {
  const again = await turnedOn("demo", "peek");

  assert.equal(again.origin, origin);
  assert.equal((await turnedOn("demo", "peek")).origin, origin);
});

/**
 * Turning a Preview on is the command refusing what it cannot drive. The app
 * obeys and displays; it decides nothing, which is what keeps the rule that
 * protects a live photo library at one seam.
 */
test("a Preview of an Action that clicks is refused in the command's own words", async () => {
  const response = await fetch(new URL("api/preview", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "demo", action: "clicker" }),
  });

  assert.equal(response.status, 400);

  const said = ((await response.json()) as { error: string }).error;
  const { stderr } = await record(workspace, "timeline", "demo", "clicker", "--preview", "--json");

  assert.equal(said, stderr.trim());
  assert.match(said, /'\.click\(\)'/);
});

test("a request to preview that names no Action is refused rather than guessed at", async () => {
  for (const body of [{}, { project: "demo" }, { project: "--all", action: "peek" }]) {
    const response = await fetch(new URL("api/preview", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 400, JSON.stringify(body));
  }

  assert.equal((await fetch(new URL("api/preview", server.url))).status, 405);
});

/**
 * A Preview is not a Run and never becomes one: it produces no Frames and no
 * Artifacts, keeps no history, and is not among the Runs this server has been
 * asked for.
 */
test("a Preview leaves no Run behind it", async () => {
  await turnedOn("demo", "peek");

  assert.deepEqual(await read("api/runs"), [], "no Run was asked for");
  assert.deepEqual(await read("api/history/demo/peek"), [], "and none is kept");
  await assert.rejects(readFile(join(workspace, "runs")), /ENOENT|EISDIR/);

  const { stdout } = await record(workspace, "status", "demo", "--json");
  assert.match(stdout, /"lastRun": null/, "and the Action still reads as never run");
});

/** Turns a Preview on, and reads back the origin and the Timeline it answered with. */
async function turnedOn(
  project: string,
  action: string,
): Promise<{ origin: string; timeline: TimelineReport }> {
  const response = await fetch(new URL("api/preview", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, action }),
  });
  const answered = await response.text();

  assert.equal(response.status, 200, answered);

  return JSON.parse(answered) as { origin: string; timeline: TimelineReport };
}

/** Whatever a path on this server answered, read as the JSON it answers with. */
async function read<Answer = unknown>(path: string): Promise<Answer> {
  const response = await fetch(new URL(path, server.url));
  const answered = await response.text();

  assert.equal(response.status, 200, `${path} answered ${response.status}: ${answered}`);

  return JSON.parse(answered) as Answer;
}

/**
 * Asks for a path exactly as it is written, and addressed exactly as it is
 * given -- which a browser's own client will not do, and which is the whole of
 * what a loopback guard and an origin guard are about.
 */
function raw(
  at: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const where = new URL(at);

  return new Promise((settle, stop) => {
    const asked = ask({ host: where.hostname, port: where.port, path, headers }, (response) => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        settle({ status: response.statusCode ?? 0, body });
      });
    });

    asked.on("error", stop);
    asked.end();
  });
}
