/**
 * Staleness: which Actions were recorded against a Project that has been
 * committed to since.
 *
 * Reported and never acted on. Nothing here records anything, and nothing here
 * decides that something ought to be recorded -- an Action going Stale is a
 * fact about the Project, and what to do about it is the operator's call.
 */
import { readActions, readProject, readProjects } from "./config.js";
import { readHistory } from "./history.js";
import { headCommit, repositoryOf } from "./repository.js";
import type { RunReport } from "./run.js";

/** What the most recent retained Run of an Action was, in as much as staleness needs. */
export type LastRun = {
  readonly id: string;
  readonly recordedAt: string;
  /** The Project's commit when it was recorded, or nothing if it had none to read. */
  readonly commit: string | null;
  /**
   * How big its Frames came out and at what scale, which is the one thing about
   * a standing clip that a Project can change underneath it without the clip
   * going Stale: `viewport.device_scale_factor` is not the Project's own
   * repository, so a clip captured before it was raised is current and soft.
   *
   * The scale is nothing where the Run's own record does not say -- every Run
   * recorded before one did is on disk without it, and reading 1 into it would
   * be answering from this reader rather than from the Run.
   */
  readonly captured: {
    readonly width: number;
    readonly height: number;
    readonly scale: number | null;
  };
};

export type ActionStatus = {
  readonly action: string;
  /** How many Runs of it are still retained. */
  readonly runs: number;
  /** The most recent of them, or nothing when the Action has never run. */
  readonly lastRun: LastRun | null;
  /** Whether the Project has been committed to since that Run. */
  readonly stale: boolean;
};

export type ProjectStatus = {
  readonly project: string;
  /** The repository staleness is read from, resolved against the workspace. */
  readonly sourceRepository: string;
  /** What that repository is at now, or nothing when there is no commit to read. */
  readonly commit: string | null;
  readonly actions: readonly ActionStatus[];
};

export type StatusReport = {
  readonly projects: readonly ProjectStatus[];
  /** Projects whose staleness could not be told, said rather than reported as current. */
  readonly warnings: readonly string[];
};

/**
 * Every Project's Actions and whether each has gone Stale, or one named
 * Project's. A Project whose repository has no commit to read cannot be told
 * either way, so its Actions are reported as they stand and the reason is
 * warned about rather than being read as "everything is current".
 */
export async function readStatus(workspace: string, only?: string): Promise<StatusReport> {
  const configured =
    only === undefined ? await readProjects(workspace) : [await readProject(workspace, only)];

  const projects = await Promise.all(
    configured.map(async (project) => {
      const sourceRepository = repositoryOf(workspace, project);
      const commit = await headCommit(sourceRepository);

      const named = await readActions(workspace, project.name);
      const actions = await Promise.all(
        named.map((action) => statusOf(workspace, project.name, action, commit)),
      );

      return { project: project.name, sourceRepository, commit, actions };
    }),
  );

  // Gathered from the finished report rather than as each Project is read, so
  // that what is warned about arrives in the order the Projects are reported in
  // however they happened to finish.
  return { projects, warnings: projects.flatMap(warningsFor) };
}

/**
 * What could not be told about a Project, so that "not Stale" is never quietly
 * read as "current". An Action nobody has run is not one of these: having no
 * Run at all is reported plainly rather than warned about.
 */
function warningsFor(project: ProjectStatus): string[] {
  if (project.commit === null) {
    return [
      `Project '${project.project}' has no commit to read at ${project.sourceRepository}, ` +
        "so its Actions cannot be told Stale",
    ];
  }

  return project.actions
    .filter((action) => action.lastRun !== null && action.lastRun.commit === null)
    .map(
      (action) =>
        `'${action.action}' was last recorded when Project '${project.project}' had no commit ` +
        "to read, so it cannot be told Stale",
    );
}

/**
 * One Action's standing. Stale is a comparison of two commits that are both
 * known: an Action nobody has run, and a Project nobody can read a commit from,
 * are each an answer of "not that I can tell" rather than of "no".
 */
async function statusOf(
  workspace: string,
  project: string,
  action: string,
  commit: string | null,
): Promise<ActionStatus> {
  const history = await readHistory(workspace, project, action);
  const last = history[0];

  const lastRun =
    last === undefined
      ? null
      : {
          id: last.id,
          recordedAt: last.recordedAt,
          commit: last.commit,
          captured: {
            width: last.frames.width,
            height: last.frames.height,
            // A Run's record is read back as what it was written as, and one
            // written before Runs said this says nothing rather than 1.
            scale: (last.frames as Partial<RunReport["frames"]>).scale ?? null,
          },
        };

  return {
    action,
    runs: history.length,
    lastRun,
    stale:
      commit !== null && lastRun !== null && lastRun.commit !== null && lastRun.commit !== commit,
  };
}
