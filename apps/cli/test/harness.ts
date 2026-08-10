/**
 * What the CLI seam's tests need in order to run the real command: the built
 * `record` binary, and a workspace belonging to the test rather than to this
 * machine. No test may depend on a real Project being present.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = resolve(import.meta.dirname, "../src/main.js");
const core = resolve(import.meta.dirname, "../../../../packages/core");

const workspaces: string[] = [];

export type CommandResult = { stdout: string; stderr: string; code: number };

/** Runs the built `record` command against a workspace of the test's own. */
export async function record(workspace: string, ...args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execute(process.execPath, [cli, ...args], {
      env: { ...process.env, RECORD_WORKSPACE: workspace },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (failure) {
    const { stdout, stderr, code } = failure as CommandResult;
    return { stdout, stderr, code };
  }
}

/**
 * A workspace holding the given Projects, each with the given `project.toml`.
 *
 * An Action imports the motion primitives from `@record/core`, so the workspace
 * has to be able to resolve the package the way a real one does -- otherwise
 * the tests would only ever exercise Actions written without them.
 */
export async function workspaceWith(projects: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "record-cli-"));
  workspaces.push(workspace);

  await mkdir(join(workspace, "node_modules", "@record"), { recursive: true });
  await symlink(core, join(workspace, "node_modules", "@record", "core"), "junction");

  for (const [name, config] of Object.entries(projects)) {
    await projectIn(workspace, name, config);
  }

  return workspace;
}

/**
 * Writes one Project's configuration into a workspace that already exists, for
 * a test whose Project has to name a path inside it.
 */
export async function projectIn(workspace: string, name: string, config: string): Promise<void> {
  await mkdir(join(workspace, "projects", name), { recursive: true });
  await writeFile(join(workspace, "projects", name, "project.toml"), config, "utf8");
}

/** Writes an Action module into a Project of a workspace. */
export async function actionIn(
  workspace: string,
  project: string,
  action: string,
  source: string,
): Promise<void> {
  const directory = join(workspace, "projects", project, "actions");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${action}.ts`), source, "utf8");
}

/**
 * Every file beneath a directory, by the name it has under it, hashed rather
 * than read into the assertion -- which is how a test says "exactly as it was"
 * about a pile of encoded video.
 */
export async function contentsOf(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });

  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = join(entry.parentPath, entry.name);

          return [
            file.slice(directory.length + 1),
            createHash("sha256")
              .update(await readFile(file))
              .digest("hex"),
          ];
        }),
    ),
  );
}

/**
 * What a Run left behind, hashed, but for the record it wrote of itself -- that
 * one names the instant the Run began, which no two Runs could ever share.
 *
 * This is how a test says "the same bytes" about a pile of encoded video, which
 * is the assertion determinism is made of.
 */
export async function artifactsOf(run: { readonly directory: string }): Promise<
  Record<string, string>
> {
  const left = await contentsOf(run.directory);
  delete left["run.json"];

  return left;
}

/**
 * How big an encoded file actually is, as ffprobe reads it back -- rather than
 * what the Run meant it to be, which the Run's own report already says.
 *
 * Asserting a size any other way would be asserting the tool against itself, so
 * this is how the CLI seam checks that a viewport or a Mockup reached the
 * encoder at all. A test wanting Frame counts or duration as well probes for
 * itself; this is the size, which is what most of them want.
 */
export async function probeSize(file: string): Promise<{ width: number; height: number }> {
  // Read first, so a file that was never written fails as a missing file rather
  // than as ffprobe having nothing to say about it.
  await stat(file);

  const { stdout } = await execute("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    file,
  ]);

  const probed = JSON.parse(stdout) as { streams?: { width: number; height: number }[] };
  const stream = probed.streams?.[0];

  if (stream === undefined) {
    throw new Error(`ffprobe found no image in ${file}`);
  }

  return { width: stream.width, height: stream.height };
}

/** Registered with `after` by every file that makes a workspace. */
export async function removeWorkspaces(): Promise<void> {
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
}
