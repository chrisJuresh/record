/**
 * What the CLI seam's tests need in order to run the real command: the built
 * `record` binary, and a workspace belonging to the test rather than to this
 * machine. No test may depend on a real Project being present.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = resolve(import.meta.dirname, "../src/main.js");

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

/** A workspace holding the given Projects, each with the given `project.toml`. */
export async function workspaceWith(projects: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "record-cli-"));
  workspaces.push(workspace);

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

/** Registered with `after` by every file that makes a workspace. */
export async function removeWorkspaces(): Promise<void> {
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
}
