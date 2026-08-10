/**
 * Run history: what a Run leaves on this machine, and how long it stays.
 *
 * Every Run owns a directory named for the instant it began, holding its
 * Artifacts, its embed snippet and the record of what it was produced under. So
 * no Run writes over another, the Latest is simply the newest of them, and a
 * Run that failed took its own directory away with it.
 *
 * Only the ten most recent survive. A Run is a pile of encoded video, and a
 * tool that kept every one of them would fill the disk of anyone who left it
 * running -- pruning is what makes keeping them safe.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RecordError } from "./errors.js";
import type { RunReport } from "./run.js";

/** How many Runs of one Action are kept. Older ones are pruned as a Run succeeds. */
export const retainedRuns = 10;

/**
 * Where the Runs of a Matrix are kept: one directory per Condition, under the
 * Action's own rather than among its Runs.
 *
 * Each Condition therefore has a Latest of its own and prunes its own ten,
 * which is the whole point -- light and dark recorded into one pile would leave
 * "the newest Run" meaning whichever of the two finished last.
 */
const conditionsDirectory = "conditions";

/** The record a Run leaves of itself, beside what it produced. */
const recordFile = "run.json";

/** What a Run's directory is named: an ISO instant a filesystem will take. */
const idPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * How far past its own instant a Run will look for a name nobody has taken. Two
 * Runs of one Action beginning within ten milliseconds of each other is not
 * something to paper over any further than this.
 */
const idAttempts = 10;

/** A Run that has somewhere to write, and knows what it will be called. */
export type BegunRun = {
  readonly id: string;
  /** When it began, as an ISO instant -- the same instant its id is named for. */
  readonly recordedAt: string;
  readonly directory: string;
};

/**
 * Where every retained Run of one Action is kept, or of one of its Conditions
 * where a Matrix recorded it under one.
 */
export function historyDirectory(
  workspace: string,
  project: string,
  action: string,
  condition?: string,
): string {
  const own = join(workspace, "runs", project, action);

  return condition === undefined ? own : join(own, conditionsDirectory, condition);
}

/** The name a Run beginning at an instant takes, in a form every filesystem accepts. */
export function runId(at: Date): string {
  return at.toISOString().replaceAll(":", "-").replace(".", "-");
}

/**
 * A directory of a Run's own, made before anything is captured into it.
 *
 * A name already taken is advanced by a millisecond rather than written into,
 * because two Runs sharing a directory would each be reading the other's
 * Artifacts as their own.
 */
export async function beginRun(
  workspace: string,
  project: string,
  action: string,
  at: Date,
  condition?: string,
): Promise<BegunRun> {
  const history = historyDirectory(workspace, project, action, condition);
  await mkdir(history, { recursive: true });

  for (let later = 0; later < idAttempts; later++) {
    const beganAt = new Date(at.getTime() + later);
    const directory = join(history, runId(beganAt));

    const made = await mkdir(directory).then(
      () => true,
      (failure: NodeJS.ErrnoException) => {
        if (failure.code === "EEXIST") {
          return false;
        }
        throw failure;
      },
    );

    if (made) {
      return { id: runId(beganAt), recordedAt: beganAt.toISOString(), directory };
    }
  }

  throw new RecordError(`'${action}' has a Run recorded at every instant around ${at.toISOString()}`);
}

/** Writes the record of a Run that succeeded, into the directory it produced. */
export async function writeRun(report: RunReport): Promise<void> {
  await writeFile(join(report.directory, recordFile), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/**
 * Every Run kept for an Action, newest first, the Runs of each of its
 * Conditions among them -- a Matrix's Runs are Runs of the same Action, and one
 * recorded in dark is not a different Action for having been.
 *
 * A directory holding no readable record is a Run that was interrupted before
 * it left one, and is passed over rather than reported as a Run that happened.
 */
export async function readHistory(
  workspace: string,
  project: string,
  action: string,
): Promise<RunReport[]> {
  const own = historyDirectory(workspace, project, action);
  const conditions = await readdir(join(own, conditionsDirectory), {
    withFileTypes: true,
  }).catch(asMissing);

  const kept = await Promise.all([
    runsIn(own),
    ...conditions
      .filter((entry) => entry.isDirectory())
      .map((entry) => runsIn(join(own, conditionsDirectory, entry.name))),
  ]);

  // Sorted across the Conditions rather than within each: what is being read is
  // the Action's history, and two Runs that began at the same instant are put
  // in the order their Conditions are named in so that the answer is settled.
  return kept
    .flat()
    .sort((one, other) => compare(other.id, one.id) || compare(nameOf(one), nameOf(other)));
}

/** The Runs kept in one directory, whether it holds an Action's or a Condition's. */
async function runsIn(directory: string): Promise<RunReport[]> {
  const kept = await Promise.all(
    (await runIds(directory)).map((id) => readRun(join(directory, id))),
  );

  return kept.filter((run) => run !== undefined);
}

/** Which Condition a Run was recorded under, and nothing for one recorded under none. */
function nameOf(run: RunReport): string {
  return run.condition?.name ?? "";
}

function compare(one: string, other: string): number {
  return one > other ? 1 : one < other ? -1 : 0;
}

/**
 * Removes every Run of an Action but the most recent `retainedRuns`, or of one
 * of its Conditions where a Matrix recorded it under one -- each Condition
 * keeps a full history of its own, since one is not a worse Run of the other.
 *
 * The leavings of an interrupted Run count as one of the ten, which is how they
 * are eventually swept up rather than accumulating unnoticed. Pruning cannot
 * fail a Run that has already produced its Artifacts, so what it could not
 * remove is left for the next Run to try again.
 */
export async function pruneHistory(
  workspace: string,
  project: string,
  action: string,
  condition?: string,
): Promise<void> {
  const directory = historyDirectory(workspace, project, action, condition);
  const older = (await runIds(directory)).slice(retainedRuns);

  await Promise.all(
    older.map((id) =>
      rm(join(directory, id), { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined),
    ),
  );
}

/**
 * The ids of every Run kept for an Action, newest first. The id is an instant
 * of fixed width, so the order the names sort in is the order they happened in.
 */
async function runIds(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(asMissing);

  return entries
    .filter((entry) => entry.isDirectory() && idPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/** The record one Run left, or nothing when it never finished leaving one. */
async function readRun(directory: string): Promise<RunReport | undefined> {
  const text = await readFile(join(directory, recordFile), "utf8").catch(() => undefined);

  if (text === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(text) as RunReport;
  } catch {
    return undefined;
  }
}

/** A directory that is not there holds no Runs; anything else is a real failure. */
function asMissing(failure: NodeJS.ErrnoException): never[] {
  if (failure.code === "ENOENT") {
    return [];
  }
  throw failure;
}
