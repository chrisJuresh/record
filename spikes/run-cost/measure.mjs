/**
 * Where a Run's wall-clock goes, stage by stage, against the fixture site.
 *
 * Throwaway evidence behind issue #41. It drives the built `record` command
 * rather than importing anything, so what it times is what an operator waits
 * for: `--progress` already says which stage a Run has reached, and the
 * timestamps of those lines are the whole measurement.
 *
 *   node measure.mjs                 one Run of one Action
 *   node measure.mjs one two three   three Actions in one request
 *   CONCURRENCY=1 node measure.mjs one two three
 *
 * It also prints the Frame hashes and Artifact sizes, so two builds can be held
 * against each other: nothing here may change a captured byte.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(import.meta.dirname, "..", "..");
const cli = join(repository, "apps", "cli", "dist", "src", "main.js");
const core = join(repository, "packages", "core");

const { fixtureSiteDirectory, freePort } = await import(
  pathToFileURL(join(repository, "packages", "fixture-site", "dist", "src", "index.js")).href
);

/** The Actions to record, which is how a request of several Runs is asked for. */
const actions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["scroll-peek"];

/**
 * `photos`' scroll-peek: 400 + 900 + 250 + 900 + 400 milliseconds at 60fps, at
 * the viewport that Project is photographed at. 171 kept Frames.
 */
const action = `
import { motion, type Action } from "@record/core";

const parameters = {
  framerate: { kind: "number", describes: "Frames per second", default: 60, min: 10, max: 120 },
} as const;

const peek: Action<typeof parameters> = {
  parameters,
  timeline({ framerate }) {
    return motion({ framerate })
      .hold(400)
      .scrollTo(1200, { durationMs: 900, easing: "ease-in-out-cubic" })
      .hold(250)
      .scrollTo(0, { durationMs: 900, easing: "ease-in-out-cubic" })
      .hold(400);
  },
};

export default peek;
`;

const port = await freePort();
const site = spawn(process.execPath, ["main.js", String(port), "0"], {
  cwd: fixtureSiteDirectory,
  stdio: "ignore",
});
await new Promise((settle) => setTimeout(settle, 700));

const workspace = await mkdtemp(join(tmpdir(), "record-run-cost-"));
await mkdir(join(workspace, "node_modules", "@record"), { recursive: true });
await symlink(core, join(workspace, "node_modules", "@record", "core"), "junction");
await mkdir(join(workspace, "projects", "bench", "actions"), { recursive: true });

await writeFile(
  join(workspace, "projects", "bench", "project.toml"),
  [
    `base_url = "http://127.0.0.1:${port}/"`,
    'source_repository = "."',
    "video_width = 1280",
    `mockup = "${process.env["MOCKUP"] ?? "browser-light"}"`,
    "",
    "[viewport]",
    "width = 1440",
    "height = 900",
    "device_scale_factor = 1",
    "",
  ].join("\n"),
  "utf8",
);

for (const name of actions) {
  await writeFile(join(workspace, "projects", "bench", "actions", `${name}.ts`), action, "utf8");
}

const asked = [
  "run",
  "bench",
  ...(actions.length === 1 ? actions : []),
  ...(process.env["CONCURRENCY"] === undefined ? [] : ["--concurrency", process.env["CONCURRENCY"]]),
];

const began = Date.now();
const stamps = [];
let answered = "";

const code = await new Promise((settle) => {
  const child = spawn(process.execPath, [cli, ...asked, "--progress", "--json"], {
    env: { ...process.env, RECORD_WORKSPACE: workspace },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";

  child.stdout.on("data", (chunk) => {
    answered += chunk;
  });
  child.stderr.on("data", (chunk) => {
    said += chunk;
    for (const line of said.split("\n").slice(0, -1)) {
      const progress = /^progress: (.*)$/.exec(line);
      if (progress !== null) {
        stamps.push({ at: Date.now() - began, ...JSON.parse(progress[1]) });
      }
    }
    said = said.slice(said.lastIndexOf("\n") + 1);
  });
  child.on("exit", settle);
});

console.log(`${asked.join(" ")}: ${code === 0 ? "recorded" : `failed (${code})`} in ${Date.now() - began}ms`);

for (const name of new Set(stamps.map((one) => one.action))) {
  const mine = stamps.filter((one) => one.action === name);
  const at = (stage) => mine.find((one) => one.stage === stage)?.at;
  const captured = mine.filter((one) => one.stage === "capturing");

  console.log(
    [
      `  ${name}:`,
      `start ${at("starting")}ms`,
      // Capture, from the Frame count reaching zero to the last one written.
      `capture ${captured.at(-1).at - captured.at(0).at}ms`,
      // Between the last Frame and encoding there is one thing: the surround.
      `surround ${at("encoding") - captured.at(-1).at}ms`,
      `encode ${(at("recorded") ?? at("failed")) - at("encoding")}ms`,
    ].join(" "),
  );
}

if (code === 0) {
  const said = JSON.parse(answered);

  for (const run of said.runs ?? [said]) {
    const sizes = await Promise.all(
      run.artifacts.map(async (one) => `${one.format} ${(await stat(one.path)).size}`),
    );

    console.log(
      `  ${run.action}: ${run.frames.captured} Frames, ${run.frames.repeated} repeated, ` +
        `hashes ${createHash("sha256").update(run.frames.hashes.join(" ")).digest("hex").slice(0, 16)}, ` +
        sizes.join(", "),
    );
  }
}

site.kill();
await rm(workspace, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
