#!/usr/bin/env node
/**
 * The `record` command. The CLI is the real interface: the server and the UI
 * reach the tool through these commands rather than around them.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  actionModule,
  defaultConcurrency,
  readActions,
  readHistory,
  readParameters,
  readProjects,
  readStatus,
  RecordError,
  resetOverrides,
  runAction,
  runActions,
  setOverrides,
  type ParameterReport,
  type ProjectConfig,
  type RunReport,
  type RunSummary,
  type StatusReport,
} from "@record/core";

const usage = `record -- repeatable clips of locally-running websites

  record projects                        List every configured Project
  record actions <project>               List a Project's Actions
  record parameters <project> <action>   Show an Action's Parameters and their values
  record set <project> <action> <name>=<value>...   Override Parameters by hand
  record reset <project> <action> <name>...         Remove Overrides
  record run <project> <action>          Record one Action and encode its Artifacts
  record run <project>                   Record every Action in a Project, at once
  record run --all                       Record every Action of every Project, at once
  record status [project]                Say which Actions have gone Stale
  record history <project> <action>      List the Runs of an Action still kept

  --set <name>=<value>         Override a Parameter for this Run, and keep it
  --all                        Record every Project rather than one named Project
  --concurrency <n>            How many Actions record at once (${defaultConcurrency})
  --json                       Emit machine-readable output
  --help                       Show this message

The workspace holding projects/ is $RECORD_WORKSPACE, or this checkout.`;

/** Commands that import an Action module, and so need a Node that reads TypeScript. */
const readsActions = ["run", "parameters", "set", "reset"];

/** Set on the relaunched process, so a Node that still cannot strip types says so once. */
const relaunched = "RECORD_TYPE_STRIPPING";

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }

  let parsed: Arguments;
  try {
    parsed = parse(argv);
  } catch (failure) {
    return fail(`${(failure as Error).message}\n\n${usage}`);
  }

  const { command, operands, json, sets, all, concurrency } = parsed;

  for (const [option, given] of [
    ["--set", sets.length > 0],
    ["--all", all],
    ["--concurrency", concurrency !== undefined],
  ] as const) {
    if (given && command !== "run") {
      return fail(`only run takes ${option}\n\n${usage}`);
    }
  }

  if (readsActions.includes(command) && !process.features.typescript) {
    return relaunchStrippingTypes(argv);
  }

  try {
    switch (command) {
      case "projects":
        if (operands.length > 0) {
          return fail(`projects takes no arguments\n\n${usage}`);
        }
        return await projects(json);
      case "actions": {
        const [project] = operands;
        if (project === undefined || operands.length > 1) {
          return fail(`actions takes the name of one Project\n\n${usage}`);
        }
        return await actions(project, json);
      }
      case "parameters": {
        const [project, action] = operands;
        if (project === undefined || action === undefined || operands.length > 2) {
          return fail(`parameters takes the name of one Project and one of its Actions\n\n${usage}`);
        }
        return report(await readParameters(workspace(), project, action), json);
      }
      case "set": {
        const [project, action, ...assignments] = operands;
        if (project === undefined || action === undefined || assignments.length === 0) {
          return fail(`set takes a Project, one of its Actions, and name=value\n\n${usage}`);
        }
        return report(await setOverrides(workspace(), project, action, assignments), json);
      }
      case "reset": {
        const [project, action, ...names] = operands;
        if (project === undefined || action === undefined || names.length === 0) {
          return fail(`reset takes a Project, one of its Actions, and Parameter names\n\n${usage}`);
        }
        return report(await resetOverrides(workspace(), project, action, names), json);
      }
      case "run": {
        const [project, action] = operands;

        if (all && operands.length > 0) {
          return fail(`run --all records every Project, so it takes no Project\n\n${usage}`);
        }
        if (!all && project === undefined) {
          return fail(`run takes a Project and one of its Actions, a Project, or --all\n\n${usage}`);
        }
        if (operands.length > 2) {
          return fail(`run takes at most one Project and one of its Actions\n\n${usage}`);
        }
        // An Override belongs to one Action, so there is no saying which of many
        // a --set meant.
        if (sets.length > 0 && action === undefined) {
          return fail(`--set names one Action's Parameter, so it takes a Project and an Action\n\n${usage}`);
        }

        return project !== undefined && action !== undefined
          ? await run(project, action, sets, json)
          : await runEvery(project, concurrency, json);
      }
      case "status": {
        const [project] = operands;
        if (operands.length > 1) {
          return fail(`status takes at most the name of one Project\n\n${usage}`);
        }
        return await status(project, json);
      }
      case "history": {
        const [project, action] = operands;
        if (project === undefined || action === undefined || operands.length > 2) {
          return fail(`history takes the name of one Project and one of its Actions\n\n${usage}`);
        }
        return await history(project, action, json);
      }
      default:
        return fail(`unknown command '${command}'\n\n${usage}`);
    }
  } catch (failure) {
    if (failure instanceof RecordError) {
      return fail(failure.message);
    }
    throw failure;
  }
}

type Arguments = {
  readonly command: string;
  readonly operands: readonly string[];
  readonly json: boolean;
  readonly sets: readonly string[];
  readonly all: boolean;
  /** How many Actions record at once, or nothing when the default stands. */
  readonly concurrency: number | undefined;
};

/** The command, its operands, and the options it was given, or a message about one it was not. */
function parse(argv: string[]): Arguments {
  const words: string[] = [];
  const sets: string[] = [];
  let json = false;
  let all = false;
  let concurrency: number | undefined;

  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at] ?? "";

    if (argument === "--json") {
      json = true;
    } else if (argument === "--all") {
      all = true;
    } else if (argument === "--set") {
      const assignment = argv[++at];
      if (assignment === undefined) {
        throw new Error("--set takes name=value");
      }
      sets.push(assignment);
    } else if (argument === "--concurrency") {
      concurrency = wholeNumber(argv[++at]);
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option '${argument}'`);
    } else {
      words.push(argument);
    }
  }

  const [command = "", ...operands] = words;

  return { command, operands, json, sets, all, concurrency };
}

/** How many Actions record at once, which is a count of Actions rather than a number. */
function wholeNumber(given: string | undefined): number {
  const count = Number(given);

  if (given === undefined || !Number.isInteger(count) || count < 1) {
    throw new Error(`--concurrency takes how many Actions record at once, not '${given ?? ""}'`);
  }

  return count;
}

async function projects(json: boolean): Promise<number> {
  const configured = await readProjects(workspace());

  return emit(json, configured, () => asTable(configured));
}

async function actions(project: string, json: boolean): Promise<number> {
  const named = await readActions(workspace(), project);

  return emit(json, named, () => `${named.join("\n")}\n`);
}

/**
 * Recording with `--set` sets the Override first and then records with it, so
 * that the two are the same thing they would have been typed separately as --
 * and so that tuning survives a Run that fails.
 */
async function run(
  project: string,
  action: string,
  sets: readonly string[],
  json: boolean,
): Promise<number> {
  if (sets.length > 0) {
    // Not warned about here: the Run is about to read the same sidecar and say
    // the same thing, and saying it twice reads as two problems.
    await setOverrides(workspace(), project, action, sets);
  }

  const recorded = await runAction(workspace(), project, action);
  warnAbout(recorded.warnings);

  return emit(json, recorded, () => asSummary(recorded));
}

/**
 * Records every Action of one Project, or of every Project, several at once.
 *
 * An Action that failed does not take the others down with it, so the command
 * fails while still reporting everything that recorded -- and what stopped each
 * one is said on stderr whichever output was asked for, because a failure is
 * exactly what must not pass unnoticed.
 */
async function runEvery(
  project: string | undefined,
  concurrency: number | undefined,
  json: boolean,
): Promise<number> {
  const recorded = await runActions(workspace(), {
    ...(project === undefined ? {} : { project }),
    ...(concurrency === undefined ? {} : { concurrency }),
  });

  warnAbout(recorded.runs.flatMap((run) => run.warnings));

  for (const failure of recorded.failures) {
    process.stderr.write(`failed: ${failure.project} ${failure.action}: ${failure.message}\n`);
  }

  emit(json, recorded, () => asRuns(recorded));

  return recorded.failures.length === 0 ? 0 : 1;
}

/**
 * Which Actions have gone Stale. Reading it changes nothing: staleness is
 * reported and never acted on, so this command never records anything.
 */
async function status(project: string | undefined, json: boolean): Promise<number> {
  const reported = await readStatus(workspace(), project);
  warnAbout(reported.warnings);

  return emit(json, reported, () => asStatus(reported));
}

/** The Runs of one Action still kept on this machine, newest first. */
async function history(project: string, action: string, json: boolean): Promise<number> {
  // Asked of the Action first: an Action nobody has run has no history, which
  // is a different answer from a name nobody declared.
  await actionModule(workspace(), project, action);

  const kept = await readHistory(workspace(), project, action);

  return emit(json, kept, () => asHistory(kept));
}

function report(reported: ParameterReport, json: boolean): number {
  warnAbout(reported.warnings);

  return emit(json, reported, () => asParameters(reported));
}

/**
 * An Action is a TypeScript module (ADR 0004), and a Node older than 22.18
 * imports one only when asked to strip types. Asking has to happen before the
 * process starts, so the command relaunches itself once. On a newer Node
 * `process.features.typescript` is already set and none of this runs.
 */
function relaunchStrippingTypes(argv: string[]): number {
  if (process.env[relaunched] !== undefined) {
    return fail(
      `this Node (${process.version}) cannot import an Action written in TypeScript. ` +
        "Node 22.18 or newer runs one unaided.",
    );
  }

  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      import.meta.filename,
      ...argv,
    ],
    { stdio: "inherit", env: { ...process.env, [relaunched]: "1" } },
  );

  return child.status ?? 1;
}

/** Machine-readable when asked for, and readable by a person otherwise. */
function emit(json: boolean, value: unknown, describe: () => string): number {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : describe());
  return 0;
}

/**
 * A stale Override is said out loud on stderr whichever output was asked for,
 * because it is in the machine-readable case that it would otherwise pass
 * unnoticed.
 */
function warnAbout(warnings: readonly string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}

/** One line per Project: its name, where it serves, and whether it is Published. */
function asTable(configured: ProjectConfig[]): string {
  const name = widest(configured.map((project) => project.name));
  const url = widest(configured.map((project) => project.baseUrl));

  return configured
    .map(
      (project) =>
        `${project.name.padEnd(name)}  ${project.baseUrl.padEnd(url)}  ` +
        `${project.published ? "published" : "not published"}\n`,
    )
    .join("");
}

/** One line per Parameter: what it is worth now, what it would be, and its range. */
function asParameters(reported: ParameterReport): string {
  const name = widest(reported.parameters.map((parameter) => parameter.name));
  const value = widest(reported.parameters.map((parameter) => String(parameter.value)));

  return reported.parameters
    .map((parameter) => {
      const range = parameter.min === undefined ? "" : `  (${parameter.min}..${parameter.max})`;
      const source = parameter.overridden ? `  overridden, default ${parameter.default}` : "";

      return `${parameter.name.padEnd(name)}  ${String(parameter.value).padEnd(value)}${range}${source}\n`;
    })
    .join("");
}

/** What a Run captured, and what it left behind. */
function asSummary(report: RunReport): string {
  const { captured, repeated } = report.frames;
  const seconds = (captured / report.framerate).toFixed(2);

  const { readyUrl, started } = report.lifecycle;

  return [
    `${report.project} ${report.action}`,
    started
      ? `  started the Project at ${readyUrl}, and stopped it again`
      : `  recorded the Project already answering at ${readyUrl}`,
    `  ${captured} Frames at ${report.framerate}fps (${seconds}s), ${repeated} repeated`,
    ...(report.overridden.length === 0
      ? []
      : [`  overridden: ${report.overridden.join(", ")}`]),
    ...report.artifacts.map(
      (artifact) =>
        `  ${artifact.format.padEnd(4)}  ${`${artifact.width}x${artifact.height}`.padEnd(9)}  ` +
        `${String(artifact.framerate).padStart(3)}fps  ${artifact.path}`,
    ),
    `  embed ${report.embed}`,
    "",
  ].join("\n");
}

/**
 * What each Action recorded, and a tally of how it went -- the Actions that
 * failed are named on stderr rather than a second time here, because one
 * failure said twice reads as two.
 */
function asRuns(recorded: RunSummary): string {
  const asked = recorded.runs.length + recorded.failures.length;

  return [
    ...recorded.runs.map(asSummary),
    `${recorded.runs.length} of ${asked} Actions recorded, ${recorded.concurrency} at a time\n`,
  ].join("");
}

/**
 * One block per Project: the commit it is at, and how each of its Actions
 * stands against it. An Action nobody has run says so rather than reading as
 * current, because the two are worth telling apart.
 */
function asStatus(reported: StatusReport): string {
  return reported.projects
    .flatMap((project) => {
      const name = widest(project.actions.map((action) => action.action));

      return [
        `${project.project}  ${project.commit === null ? "no commit" : shortCommit(project.commit)}`,
        ...project.actions.map((action) => {
          const standing = action.lastRun === null ? "never run" : action.stale ? "stale" : "current";
          const last =
            action.lastRun === null ? "" : `  ${action.lastRun.recordedAt}  ${action.runs} kept`;

          return `  ${action.action.padEnd(name)}  ${standing.padEnd("never run".length)}${last}`;
        }),
      ];
    })
    .map((line) => `${line}\n`)
    .join("");
}

/** One line per retained Run, newest first: when it ran, against what, and how it was tuned. */
function asHistory(kept: readonly RunReport[]): string {
  return kept
    .map((run) => {
      const commit = run.commit === null ? "no commit" : shortCommit(run.commit);
      const tuned = run.overridden.length === 0 ? "" : `  overridden: ${run.overridden.join(", ")}`;

      return `${run.recordedAt}  ${commit}  ${run.frames.captured} Frames at ${run.framerate}fps${tuned}\n`;
    })
    .join("");
}

/** As much of a commit as a person reads, which is as much as git itself shows. */
function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

function widest(values: string[]): number {
  return Math.max(0, ...values.map((value) => value.length));
}

function workspace(): string {
  return process.env["RECORD_WORKSPACE"] ?? resolve(import.meta.dirname, "../../../..");
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}
