/**
 * The local server, asserted at the CLI seam.
 *
 * The server has no seam of its own on purpose: it holds no recording logic,
 * and everything it answers is the `record` command invoked and read back. So
 * it is started here exactly as anything else would start it -- by running the
 * command -- and asked over HTTP, and what it says is held against what the
 * command says for itself.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { get, request as ask } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { ParameterReport, RunProgress, RunReport, RunSummary } from "@record/core";
import type { RunRequest } from "@record/server";
import { startFixtureSite, type FixtureSite } from "@record/fixture-site";

import {
  actionIn,
  record,
  removeWorkspaces,
  serving,
  workspaceWith,
  type ServedRecord,
} from "./harness.js";

/** Small on purpose: every Frame is a screenshot and an encode. */
const peek = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate })
      .hold(100)
      .scrollTo(200, { durationMs: 400, easing: "ease-in-out-cubic" })
      .hold(100);
  },
};

export default peek;
`;

/** An Action that cannot record, so that what a failure reads as can be asserted. */
const broken = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
} as const;

const broken: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate })
      .hold(100)
      .waitFor("window.__nothingEverSetsThis === true", {
        durationMs: 100,
        describes: "something this page never does",
      });
  },
};

export default broken;
`;

/**
 * An Action that describes no clip at all, so it fails before a browser is ever
 * asked for -- which is what makes the request it belongs to cheap enough to
 * assert against beside two real Runs.
 */
const nothing = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 20, min: 1, max: 120 },
} as const;

const nothing: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate });
  },
};

export default nothing;
`;

// 100ms + 400ms + 100ms at 20fps.
const expectedFrames = 12;

/** A Project nothing is ever recorded against, since its Action describes no clip. */
const hollow = ['base_url = "http://127.0.0.1:1/"', 'source_repository = "."', ""].join("\n");

let site: FixtureSite;
let workspace: string;
let server: ServedRecord;

/**
 * One Run asked for over HTTP and watched to the end, one that could not
 * record, and one request that describes no clip at all. Every test here reads
 * these rather than asking for Runs of its own: each Run is a browser and an
 * encoder, and the rest of the suite is recording at the same time.
 */
let recorded: RunRequest;
let watched: Watched;
let alsoWatched: Watched;
let failed: RunRequest;
let failing: Watched;
let refused: RunRequest;

before(async () => {
  site = await startFixtureSite();
  workspace = await workspaceWith({
    demo: [
      `base_url = "${site.url}"`,
      `source_repository = "."`,
      "video_width = 320",
      'mockup = "none"',
      "",
      "[viewport]",
      "width = 400",
      "height = 300",
      "device_scale_factor = 1",
      "",
    ].join("\n"),
    hollow,
  });
  await actionIn(workspace, "demo", "peek", peek);
  await actionIn(workspace, "demo", "broken", broken);
  await actionIn(workspace, "hollow", "nothing", nothing);

  server = await serving(workspace);

  // Watched twice at once, because progress goes to whoever is connected: a
  // second browser tab is not a client the first one has taken the Run from.
  const begun = await askFor({ project: "demo", action: "peek" });
  [watched, alsoWatched] = await Promise.all([
    watch(`api/runs/${begun.id}/events`),
    watch(`api/runs/${begun.id}/events`),
  ]);
  recorded = await read<RunRequest>(`api/runs/${begun.id}`);

  // ...one that gets as far as the browser and then cannot record...
  const failingRun = await askFor({ project: "demo", action: "broken" });
  failing = await watch(`api/runs/${failingRun.id}/events`);
  failed = await read<RunRequest>(`api/runs/${failingRun.id}`);

  // ...and a whole Project whose Action describes no clip, which the command
  // refuses while still answering with a summary of what it refused.
  const refusedRun = await askFor({ project: "hollow", concurrency: 1 });
  await watch(`api/runs/${refusedRun.id}/events`);
  refused = await read<RunRequest>(`api/runs/${refusedRun.id}`);
});

after(async () => {
  await server.close();
  await site.close();
  await removeWorkspaces();
});

/**
 * A tool that starts processes on this machine has no business answering
 * anything else. It binds loopback, and it refuses a request addressed by any
 * other name -- which is how a page elsewhere would reach a local server that
 * merely bound the right interface.
 */
test("the server serves a loopback address and answers only requests addressed to it", async () => {
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  assert.equal((await raw("/api/projects", { host: "records.example.com" })).status, 403);
  assert.equal((await raw("/api/projects", { host: "localhost" })).status, 200);
});

test("a HEAD says how a Run would be watched rather than holding the connection open", async () => {
  const asked = await read<RunRequest[]>("api/runs");
  const id = asked.at(0)?.id ?? "";

  const answered = await raw(`/api/runs/${id}/events`, {}, "HEAD");

  assert.equal(answered.status, 200);
  assert.equal(answered.body, "");
});

test("listing Projects over HTTP is exactly what the command says", async () => {
  const { stdout, code } = await record(workspace, "projects", "--json");
  assert.equal(code, 0);

  assert.deepEqual(await read("api/projects"), JSON.parse(stdout));
});

test("listing a Project's Actions over HTTP is exactly what the command says", async () => {
  const { stdout, code } = await record(workspace, "actions", "demo", "--json");
  assert.equal(code, 0);

  assert.deepEqual(await read("api/projects/demo/actions"), JSON.parse(stdout));
  assert.deepEqual(await read("api/projects/demo/actions"), ["broken", "peek"]);
});

test("an Action's Parameters and the Mockups a clip can be shown in are served", async () => {
  const { stdout } = await record(workspace, "parameters", "demo", "peek", "--json");

  assert.deepEqual(await read("api/projects/demo/actions/peek/parameters"), JSON.parse(stdout));
  assert.ok((await read<{ name: string }[]>("api/mockups")).some((one) => one.name === "laptop"));
});

/**
 * Tuning over HTTP is `record set` and `record reset`, so an Override written
 * from the app is the same line in the same sidecar as one written by hand --
 * and what comes back is the report the command gives for itself, which is how
 * whatever asked finds out what the Action will now run with.
 */
test("an Override is set over HTTP, into the sidecar the command writes", async () => {
  const set = await written("api/projects/demo/actions/peek/parameters", {
    set: ["framerate=15"],
  });

  assert.deepEqual(set, JSON.parse((await record(workspace, "parameters", "demo", "peek", "--json")).stdout));
  assert.deepEqual(
    set.parameters.filter((parameter) => parameter.overridden).map((parameter) => parameter.name),
    ["framerate"],
  );
  assert.match(await readFile(set.sidecar, "utf8"), /framerate = 15/);
});

test("an Override is reset over HTTP, and the declared default is what is left", async () => {
  await written("api/projects/demo/actions/peek/parameters", { set: ["framerate=15"] });

  const reset = await written("api/projects/demo/actions/peek/parameters/reset", {
    reset: ["framerate"],
  });

  const framerate = reset.parameters.find((parameter) => parameter.name === "framerate");

  assert.equal(framerate?.overridden, false);
  assert.equal(framerate?.value, framerate?.default);
  assert.deepEqual(reset, JSON.parse((await record(workspace, "parameters", "demo", "peek", "--json")).stdout));
});

/**
 * A value the Action will not take is refused in the command's own words, since
 * "outside the declared range 1..120" is what tells whoever typed it what to
 * type instead.
 */
test("a value the Action refuses is answered with what the command said about it", async () => {
  const refused = await fetch(new URL("api/projects/demo/actions/peek/parameters", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ set: ["framerate=1000"] }),
  });

  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(await refused.json()), /takes a number between 1 and 120/);

  const nothing = await fetch(new URL("api/projects/demo/actions/peek/parameters/reset", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reset: ["framerate"] }),
  });

  assert.equal(nothing.status, 400);
  assert.match(JSON.stringify(await nothing.json()), /is not overridden, so there is nothing to reset/);
});

test("status over HTTP is exactly what the command says", async () => {
  const { stdout, code } = await record(workspace, "status", "demo", "--json");
  assert.equal(code, 0);

  assert.deepEqual(await read("api/status?project=demo"), JSON.parse(stdout));
});

test("the Runs an Action still keeps are served, newest first", async () => {
  const kept = await read<RunReport[]>("api/history/demo/peek");
  const { stdout } = await record(workspace, "history", "demo", "peek", "--json");

  assert.deepEqual(kept, JSON.parse(stdout));
  assert.ok(
    kept.some((run) => run.id === (recorded.report as RunReport).id),
    "the Run asked for over HTTP is among them",
  );
  assert.deepEqual(
    [...kept].sort((one, other) => (one.recordedAt < other.recordedAt ? 1 : -1)),
    kept,
    "newest first",
  );
});

/**
 * The reason the server exists rather than the UI shelling out: a ten-second
 * render must not look like a hang. The request to record is answered at once
 * and what the Run is doing arrives as it does it -- so a client that watched
 * from the start saw the Frames arrive rather than a report at the end.
 */
test("a Run's progress is streamed to a client while the Run is in flight", async () => {
  const stages = watched.events
    .filter((event) => event.name === "progress")
    .map((event) => event.data as RunProgress);

  assert.ok(stages.length > expectedFrames, `only ${stages.length} progresses for 12 Frames`);
  assert.deepEqual(
    [...new Set(stages.map((stage) => stage.stage))],
    ["starting", "capturing", "encoding", "recorded"],
  );

  const captured = stages
    .filter((stage) => stage.frames !== undefined)
    .map((stage) => stage.frames?.captured);

  assert.deepEqual(captured, [...Array(expectedFrames + 1).keys()], "a Frame at a time");
  assert.ok(
    stages.every((stage) => stage.project === "demo" && stage.action === "peek"),
    "every progress names the Run it belongs to",
  );

  // ...and it arrived as the Run went, rather than in one piece at the end.
  assert.ok(
    watched.closed - watched.opened > 200,
    `the whole stream arrived within ${watched.closed - watched.opened}ms`,
  );

  // ...and every client connected to it was told, not just the first.
  assert.deepEqual(alsoWatched.events, watched.events);
});

test("a Run watched to the end reports what it produced", async () => {
  const ended = watched.events.at(-1);

  assert.equal(ended?.name, "recorded");
  assert.equal(recorded.state, "recorded");

  const report = recorded.report as RunReport;
  assert.equal(report.action, "peek");
  assert.equal(report.frames.captured, expectedFrames);
  assert.deepEqual(
    report.artifacts.map((artifact) => artifact.format),
    ["mp4", "webm", "gif"],
  );
});

/**
 * The server rephrasing a failure would leave the operator unable to tell a
 * stale selector from a Project that would not start, which is the whole of
 * what a failure is for.
 */
test("a failing Run surfaces the command's own failure message", () => {
  assert.equal(failed.state, "failed");
  assert.match(
    failed.message ?? "",
    /waited for something this page never does, which never became true/,
  );

  // ...and a client watching it saw it get as far as it got, then stop.
  const stages = failing.events
    .filter((event) => event.name === "progress")
    .map((event) => (event.data as RunProgress).stage);

  assert.ok(stages.includes("capturing"), "the Run captured Frames before it failed");
  assert.equal(stages.at(-1), "failed");
  assert.equal(failing.events.at(-1)?.name, "failed");
});

test("an Action nobody declared is refused in the command's own words", async () => {
  const asked = await askFor({ project: "demo", action: "nothing-like-it" });
  const seen = await watch(`api/runs/${asked.id}/events`);
  const ended = await read<RunRequest>(`api/runs/${asked.id}`);

  assert.equal(seen.events.at(-1)?.name, "failed");
  assert.equal(ended.state, "failed");
  assert.match(ended.message ?? "", /no Action named 'nothing-like-it' is declared/);
});

/**
 * One Action failing does not abandon the others, so a request recording a
 * whole Project can fail and still have a summary to report. The server hands
 * on both rather than throwing the answer away with the failure.
 */
test("a request the command refused still carries the answer it gave", () => {
  const summary = refused.report as RunSummary;

  assert.equal(refused.state, "failed");
  assert.deepEqual(summary.runs, []);
  assert.deepEqual(
    summary.failures.map((failure) => failure.action),
    ["nothing"],
  );
  assert.equal(summary.concurrency, 1, "the request's own concurrency reached the command");
  assert.match(refused.message ?? "", /failed: hollow nothing.*produces no Frames/);
});

test("the requests to record this server has been asked for are readable", async () => {
  const asked = await read<RunRequest[]>("api/runs");

  assert.ok(asked.some((request) => request.id === recorded.id));
  assert.ok(asked.every((request) => request.words[0] === "run"));
});

/**
 * A clip is watched where it will be embedded rather than opened out of a
 * folder, which means the bytes on disk, under the right type, and answering
 * the byte ranges a video element asks for.
 */
test("the Artifacts of a Run are served for playback in a browser", async () => {
  const report = recorded.report as RunReport;
  const mp4 = report.artifacts.find((artifact) => artifact.format === "mp4");
  assert.ok(mp4 !== undefined);

  const path = `artifacts/demo/peek/${report.id}/peek.mp4`;
  const response = await fetch(new URL(path, server.url));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    await readFile(join(report.directory, "peek.mp4")),
  );

  const embed = await fetch(new URL(`artifacts/demo/peek/${report.id}/peek.embed.html`, server.url));

  assert.equal(embed.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await embed.text(), /<source src="peek\.webm"/);
});

test("an Artifact answers the byte range a video element asks it for", async () => {
  const report = recorded.report as RunReport;
  const path = `artifacts/demo/peek/${report.id}/peek.mp4`;

  const ranged = await fetch(new URL(path, server.url), { headers: { range: "bytes=8-23" } });
  const whole = await readFile(join(report.directory, "peek.mp4"));

  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 8-23/${whole.length}`);
  assert.equal(ranged.headers.get("content-length"), "16");
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), whole.subarray(8, 24));

  const beyond = await fetch(new URL(path, server.url), {
    headers: { range: `bytes=${whole.length + 10}-` },
  });

  assert.equal(beyond.status, 416);
});

/**
 * A path is asked for exactly as it is written here, rather than through a
 * client that would tidy it up first -- the point is what the server does with
 * a path nobody tidied.
 */
test("nothing outside the workspace's Runs is served, however a path is spelled", async () => {
  for (const path of [
    "/artifacts/../../package.json",
    "/artifacts/demo/%2e%2e/%2e%2e/%2e%2e/package.json",
    "/artifacts/%2e%2e%2fpackage.json",
    "/artifacts/demo/peek/..%2F..%2F..%2Fpackage.json",
  ]) {
    const answered = await raw(path);

    assert.ok([403, 404].includes(answered.status), `${path} answered ${answered.status}`);
    assert.doesNotMatch(answered.body, /"name": "record"/, `${path} served a file outside the Runs`);
  }

  assert.equal((await raw("/artifacts/demo/peek/nothing.mp4")).status, 404);
});

test("a path the server does not serve says so rather than answering something else", async () => {
  assert.equal((await fetch(new URL("api/nothing", server.url))).status, 404);
  assert.equal((await fetch(new URL("nothing", server.url))).status, 404);

  const written = await fetch(new URL("api/projects", server.url), { method: "POST" });
  assert.equal(written.status, 405);
});

test("a request to record that names nothing recordable is refused rather than run", async () => {
  const response = await fetch(new URL("api/runs", server.url), {
    method: "POST",
    body: JSON.stringify({ project: "--all" }),
  });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /not the name of a project/);
});

/**
 * Asks for a path exactly as it is written, and addressed exactly as it is
 * given -- which a browser's own client will not do, and which is the whole of
 * what a loopback guard and a path guard are about.
 */
function raw(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((settle, stop) => {
    const asked = ask(
      { host: "127.0.0.1", port: new URL(server.url).port, path, headers, method },
      (response) => {
        let body = "";

        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          settle({ status: response.statusCode ?? 0, body });
        });
      },
    );

    asked.on("error", stop);
    asked.end();
  });
}

/** Whatever a path answered, read as the JSON it answers with. */
async function read<Answer = unknown>(path: string): Promise<Answer> {
  const response = await fetch(new URL(path, server.url));
  const answered = await response.text();

  assert.equal(response.status, 200, `${path} answered ${response.status}: ${answered}`);

  return JSON.parse(answered) as Answer;
}

/** Asks the server to write something, and reads back what the command answered. */
async function written(path: string, body: unknown): Promise<ParameterReport> {
  const response = await fetch(new URL(path, server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answered = await response.text();

  assert.equal(response.status, 200, `${path} answered ${response.status}: ${answered}`);

  return JSON.parse(answered) as ParameterReport;
}

/** Asks the server to record, which it answers before the Run is anywhere near done. */
async function askFor(body: unknown): Promise<RunRequest> {
  const response = await fetch(new URL("api/runs", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answered = await response.text();

  assert.equal(response.status, 202, answered);

  return JSON.parse(answered) as RunRequest;
}

/** A stream of events, and when the first and the last of them arrived. */
type Watched = {
  readonly events: readonly { readonly name: string; readonly data: unknown }[];
  readonly opened: number;
  readonly closed: number;
};

/**
 * Watches a Run to the end. The times are what says the events arrived as the
 * Run went rather than in one piece once it was over.
 */
function watch(path: string): Promise<Watched> {
  return new Promise((settle, stop) => {
    const request = get(new URL(path, server.url), (response) => {
      if (response.statusCode !== 200) {
        stop(new Error(`watching ${path} answered ${response.statusCode ?? "nothing"}`));
        return;
      }

      let text = "";
      let opened = 0;

      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        opened = opened === 0 ? Date.now() : opened;
        text += chunk;
      });
      response.on("end", () => {
        settle({ events: eventsIn(text), opened, closed: Date.now() });
      });
    });

    request.on("error", stop);
  });
}

/** The server-sent events some text carries, each named and carrying its JSON. */
function eventsIn(text: string): { name: string; data: unknown }[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const name = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null";

      return { name, data: JSON.parse(data) as unknown };
    });
}
