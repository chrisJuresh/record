/**
 * A Project's own git repository. It is read and never written (ADR 0003), and
 * read for exactly one thing: the commit the Project is at, which is what a Run
 * records and what staleness compares against.
 *
 * The working tree is deliberately never consulted. An Action that went Stale
 * every time a file was saved would be a flag nobody reads, so only commits
 * count.
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { ProjectConfig } from "./config.js";

const execute = promisify(execFile);

/** Where a Project's repository is: its `source_repository`, against the workspace. */
export function repositoryOf(workspace: string, project: ProjectConfig): string {
  return resolve(workspace, project.sourceRepository);
}

/**
 * The commit a repository is at, or nothing when there is none to read -- a
 * directory that is not a repository, or one nobody has committed to yet.
 * Staleness is a question being asked rather than work being done, so an
 * unreadable repository answers "unknown" instead of failing the command.
 */
export async function headCommit(directory: string): Promise<string | null> {
  return execute("git", ["-C", directory, "rev-parse", "HEAD"]).then(
    ({ stdout }) => stdout.trim() || null,
    () => null,
  );
}
