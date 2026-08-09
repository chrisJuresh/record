/**
 * What the CLI seam's tests need in order to run the real command: the built
 * `record` binary, and a workspace belonging to the test rather than to this
 * machine. No test may depend on a real Project being present.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
    await mkdir(join(workspace, "projects", name), { recursive: true });
    await writeFile(join(workspace, "projects", name, "project.toml"), config, "utf8");
  }

  return workspace;
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

/** Registered with `after` by every file that makes a workspace. */
export async function removeWorkspaces(): Promise<void> {
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
}
