#!/usr/bin/env node
/**
 * The `record` command. The CLI is the real interface: the server and the UI
 * reach the tool through these commands rather than around them.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  readActions,
  readParameters,
  readProjects,
  RecordError,
  resetOverrides,
  runAction,
  setOverrides,
  type ParameterReport,
  type ProjectConfig,
  type RunReport,
} from "@record/core";

const usage = `record -- repeatable clips of locally-running websites

  record projects                        List every configured Project
  record actions <project>               List a Project's Actions
  record parameters <project> <action>   Show an Action's Parameters and their values
  record set <project> <action> <name>=<value>...   Override Parameters by hand
  record reset <project> <action> <name>...         Remove Overrides
  record run <project> <action>          Record one Action and encode its Artifacts

  --set <name>=<value>         Override a Parameter for this Run, and keep it
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

  const { command, operands, json, sets } = parsed;

  if (sets.length > 0 && command !== "run") {
    return fail(`only run takes --set\n\n${usage}`);
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
        if (project === undefined || action === undefined || operands.length > 2) {
          return fail(`run takes the name of one Project and one of its Actions\n\n${usage}`);
        }
        return await run(project, action, sets, json);
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
};

/** The command, its operands, and the options it was given, or a message about one it was not. */
function parse(argv: string[]): Arguments {
  const words: string[] = [];
  const sets: string[] = [];
  let json = false;

  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at] ?? "";

    if (argument === "--json") {
      json = true;
    } else if (argument === "--set") {
      const assignment = argv[++at];
      if (assignment === undefined) {
        throw new Error("--set takes name=value");
      }
      sets.push(assignment);
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option '${argument}'`);
    } else {
      words.push(argument);
    }
  }

  const [command = "", ...operands] = words;

  return { command, operands, json, sets };
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
