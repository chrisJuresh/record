/**
 * Publishing: the Latest Artifacts of every Published Project, copied into a
 * tracked directory of this repository, committed and pushed.
 *
 * This is the only irreversible, outward-facing thing the tool does, and the
 * only route by which something private could become public -- so it is two
 * steps rather than one. Asked without confirmation it works out exactly what
 * would go public, down to the file and the byte, and does none of it. Asked
 * with confirmation it carries out that same plan.
 *
 * Per ADR 0007 the only repository it ever writes to is this one. Nothing here
 * reads from, writes to, commits to or pushes a Project's own repository, and
 * the commit it makes names the published directory alone -- so work sitting
 * uncommitted elsewhere in this repository cannot be swept up by a button
 * pressed without thinking.
 *
 * Run history is never published (ADR 0007). What is copied is the Latest of
 * each history and nothing behind it, and the record a Run left of itself stays
 * on this machine.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { readActions, readProjects } from "./config.js";
import { RecordError } from "./errors.js";
import { readConditions, readHistory } from "./history.js";
import type { RunReport } from "./run.js";

const execute = promisify(execFile);

/**
 * The tracked directory Published clips are copied into. One public location
 * serves every Project, including the private ones, which is what makes a clip
 * linkable from a repository nobody else can read (ADR 0007).
 */
export const publishedDirectory = "published";

/** One file a publish would put into that directory. */
export type PublishedFile = {
  /**
   * Where it lands, under the workspace and written with forward slashes: it is
   * as much the URL it will be linked by as it is a path on this machine.
   */
  readonly path: string;
  readonly bytes: number;
  /** The Artifact on this machine it is copied from. */
  readonly from: string;
};

/** What one Action contributes: the Artifacts of its Latest, and when that ran. */
export type PublishedAction = {
  readonly action: string;
  /** The Condition this Latest was recorded under, and nothing for the Action's own. */
  readonly condition: string | null;
  /** When that Run recorded, so a plan says how old what it is about to publish is. */
  readonly recordedAt: string;
  readonly files: readonly PublishedFile[];
};

export type PublishedProject = {
  readonly project: string;
  readonly actions: readonly PublishedAction[];
};

/**
 * Exactly what a publish would make public: which Projects, which files, and
 * how big each of them is. Nothing is confirmed by anyone who cannot read this
 * first, so it says everything that would change -- including what would be
 * taken back out, since a Project that has stopped being Published is a clip
 * that has to stop being public.
 */
export type PublishPlan = {
  /** The tracked directory this would write into, under the workspace. */
  readonly directory: string;
  readonly projects: readonly PublishedProject[];
  /** Every file about to be written, gathered from the Projects above. */
  readonly files: readonly PublishedFile[];
  /** ...and every one about to be taken out, by the path it is at now. */
  readonly removing: readonly string[];
  /** How much is about to be public, in bytes. */
  readonly bytes: number;
  /** What the plan could not account for, said rather than quietly left out. */
  readonly warnings: readonly string[];
};

export type PublishReport = {
  readonly plan: PublishPlan;
  /** Whether it was carried out, rather than shown and left for confirmation. */
  readonly published: boolean;
  /** The commit this repository now stands at, or nothing where none was made. */
  readonly commit: string | null;
  /** Whether this repository was pushed, which is the only one ever pushed. */
  readonly pushed: boolean;
};

export type PublishOptions = {
  /**
   * Whether to carry the plan out. Without it nothing is copied, committed or
   * pushed: the plan is the answer, and confirming it is a second request.
   */
  readonly confirm?: boolean;
};

/**
 * What publishing would make public, worked out and nothing done about it.
 *
 * A Project that is not Published contributes nothing here, which is the whole
 * of what the setting means: its Artifacts stay on this machine.
 */
export async function planPublish(workspace: string): Promise<PublishPlan> {
  const warnings: string[] = [];
  const projects: PublishedProject[] = [];

  for (const project of (await readProjects(workspace)).filter((one) => one.published)) {
    const actions: PublishedAction[] = [];

    for (const action of await readActions(workspace, project.name)) {
      // The Action's own history and each of its Conditions', because every one
      // of them is a stream with a Latest of its own -- a clip of the dark theme
      // is not a worse Run of the light one.
      const conditions = await readConditions(workspace, project.name, action);

      for (const condition of [undefined, ...conditions]) {
        const latest = (await readHistory(workspace, project.name, action, condition))[0];

        if (latest === undefined) {
          continue;
        }

        actions.push({
          action,
          condition: condition ?? null,
          recordedAt: latest.recordedAt,
          files: await filesOf(project.name, action, latest, warnings),
        });
      }
    }

    if (actions.length === 0) {
      warnings.push(
        `Project '${project.name}' is Published and has no Run to publish, so it contributes ` +
          "nothing",
      );
    }

    projects.push({ project: project.name, actions });
  }

  const files = projects.flatMap((project) => project.actions.flatMap((action) => action.files));

  atOnePathEach(files);

  const present = new Set(files.map((file) => file.path));

  if (!(await isRepository(workspace))) {
    warnings.push(
      `${workspace} is not a git repository, so there is nothing here to commit these to`,
    );
  }

  return {
    directory: publishedDirectory,
    projects,
    files,
    removing: (await publishedAlready(workspace)).filter((path) => !present.has(path)),
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    warnings,
  };
}

/**
 * Publishes, or says what publishing would do and does none of it.
 *
 * Confirmation is not optional and it is not a prompt: the plan is one request
 * and carrying it out is another, so that whatever is asking -- a person at a
 * terminal, or the app on this machine -- has read exactly what is about to go
 * public before it says yes.
 */
export async function publishClips(
  workspace: string,
  options: PublishOptions = {},
): Promise<PublishReport> {
  const plan = await planPublish(workspace);

  if (options.confirm !== true) {
    return { plan, published: false, commit: null, pushed: false };
  }

  if (!(await isRepository(workspace))) {
    throw new RecordError(
      `${workspace} is not a git repository, so there is nothing here to commit these to -- ` +
        "publishing commits and pushes this repository and nothing else (ADR 0007)",
    );
  }

  for (const file of plan.files) {
    const to = join(workspace, ...file.path.split("/"));

    await mkdir(dirname(to), { recursive: true });
    await copyFile(file.from, to);
  }

  // A Project that has stopped being Published is a clip that has to stop being
  // public, so what is no longer in the plan goes -- and the directories it
  // leaves behind go with it, rather than standing as empty Projects.
  for (const path of plan.removing) {
    await rm(join(workspace, ...path.split("/")), { force: true });
  }
  await pruneEmpty(join(workspace, publishedDirectory));

  return commitAndPush(workspace, plan);
}

/**
 * Commits the published directory and nothing else, and pushes this repository.
 *
 * The commit names that directory as its pathspec, so whatever else is staged
 * or edited in this repository stays exactly where it is: committing the wrong
 * thing on the wrong branch is the failure mode ADR 0007 exists to avoid, and a
 * publish that swept up unrelated work would be that failure by another route.
 */
async function commitAndPush(workspace: string, plan: PublishPlan): Promise<PublishReport> {
  const changed = await git(workspace, ["status", "--porcelain", "--", publishedDirectory]);

  // What was published is already what is public. Nothing to commit is not a
  // failure: it is the answer to having published twice.
  if (changed.trim() === "") {
    return { plan, published: true, commit: null, pushed: false };
  }

  await git(workspace, ["add", "--all", "--", publishedDirectory]);
  await git(workspace, ["commit", "--message", messageFor(plan), "--", publishedDirectory]);

  const commit = await git(workspace, ["rev-parse", "HEAD"]);

  try {
    await git(workspace, ["push"]);
  } catch (failure) {
    // The commit is made and the clips are not public yet, which is exactly
    // what has to be said: the next step is a push rather than a publish.
    throw new RecordError(
      `the clips were committed as ${commit.slice(0, 7)} and this repository could not be ` +
        `pushed: ${(failure as Error).message}`,
    );
  }

  return { plan, published: true, commit, pushed: true };
}

/** What the commit says it did, which is which Projects went public. */
function messageFor(plan: PublishPlan): string {
  const named = plan.projects
    .filter((project) => project.actions.length > 0)
    .map((project) => project.project);

  return named.length === 0
    ? `Take every published clip out of ${publishedDirectory}/`
    : `Publish the Latest clips of ${named.join(", ")}`;
}

/**
 * The Artifacts of one Latest, by where each would land. Only the Artifacts:
 * the record a Run left of itself is history, and history is never published.
 *
 * An Artifact its Run's record names and this machine does not have is said and
 * left out, because a plan that listed a file nobody could copy would be a plan
 * that lied about what is going public.
 */
async function filesOf(
  project: string,
  action: string,
  latest: RunReport,
  warnings: string[],
): Promise<PublishedFile[]> {
  const files: PublishedFile[] = [];

  for (const artifact of latest.artifacts) {
    const found = await stat(artifact.path).catch(() => undefined);

    if (found === undefined) {
      warnings.push(
        `'${project} ${action}' has no ${artifact.format} where its Latest says it left one ` +
          `(${artifact.path}), so it is not published`,
      );
      continue;
    }

    files.push({
      path: [publishedDirectory, project, action, basename(artifact.path)].join("/"),
      bytes: found.size,
      from: artifact.path,
    });
  }

  return files;
}

/**
 * That no two Artifacts would land on top of each other. Their names are the
 * Action's and the Condition's, so this takes an Action deliberately named to
 * collide with another's Condition -- but one clip quietly published under a
 * name claiming to be another is the one outcome worth refusing the whole plan
 * over.
 */
function atOnePathEach(files: readonly PublishedFile[]): void {
  const taken = new Map<string, string>();

  for (const file of files) {
    const already = taken.get(file.path);

    if (already !== undefined) {
      throw new RecordError(
        `${file.from} and ${already} would both be published as ${file.path}, so one of them ` +
          "would be a clip under another's name",
      );
    }

    taken.set(file.path, file.from);
  }
}

/** Every file the published directory holds now, by the path the plan names it at. */
async function publishedAlready(workspace: string): Promise<string[]> {
  const directory = join(workspace, publishedDirectory);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(asMissing);

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const under = relative(directory, join(entry.parentPath, entry.name));

      return [publishedDirectory, ...under.split(sep)].join("/");
    })
    .sort();
}

/**
 * Removes the directories left holding nothing, innermost first, and the
 * published directory itself where every clip has gone from it.
 */
async function pruneEmpty(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(asMissing);

  for (const entry of entries.filter((one) => one.isDirectory())) {
    await pruneEmpty(join(directory, entry.name));
  }

  if ((await readdir(directory).catch(asMissing)).length === 0) {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Whether the workspace is a repository at all, which is what publishing writes to. */
async function isRepository(workspace: string): Promise<boolean> {
  return git(workspace, ["rev-parse", "--git-dir"]).then(
    () => true,
    () => false,
  );
}

/** git, run against this repository and never against a Project's (ADR 0007). */
async function git(workspace: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execute("git", ["-C", workspace, ...args]);

    return stdout.trim();
  } catch (failure) {
    const said = (failure as { stderr?: string }).stderr ?? "";

    throw new RecordError(said.trim() || (failure as Error).message);
  }
}

/** A directory that is not there holds nothing; anything else is a real failure. */
function asMissing(failure: NodeJS.ErrnoException): never[] {
  if (failure.code === "ENOENT") {
    return [];
  }
  throw failure;
}
