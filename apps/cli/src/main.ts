#!/usr/bin/env node
/**
 * The `record` command. The CLI is the real interface: the server and the UI
 * reach the tool through these commands rather than around them.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  readActions,
  readProjects,
  RecordError,
  runAction,
  type ProjectConfig,
  type RunReport,
} from "@record/core";

const usage = `record -- repeatable clips of locally-running websites

  record projects              List every configured Project
  record actions <project>     List a Project's Actions
  record run <project> <action>  Record one Action and encode its Artifacts

  --json                       Emit machine-readable output
  --help                       Show this message

The workspace holding projects/ is $RECORD_WORKSPACE, or this checkout.`;

/** Set on the relaunched process, so a Node that still cannot strip types says so once. */
const relaunched = "RECORD_TYPE_STRIPPING";

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }

  const options = argv.filter((argument) => argument.startsWith("-"));
  const unknown = options.find((option) => option !== "--json");
  if (unknown !== undefined) {
    return fail(`unknown option '${unknown}'\n\n${usage}`);
  }

  const json = options.includes("--json");
  const [command, ...operands] = argv.filter((argument) => !argument.startsWith("-"));

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
      case "run": {
        const [project, action] = operands;
        if (project === undefined || action === undefined || operands.length > 2) {
          return fail(`run takes the name of one Project and one of its Actions\n\n${usage}`);
        }
        return await run(project, action, json, argv);
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

async function projects(json: boolean): Promise<number> {
  const configured = await readProjects(workspace());

  return emit(json, configured, () => asTable(configured));
}

async function actions(project: string, json: boolean): Promise<number> {
  const named = await readActions(workspace(), project);

  return emit(json, named, () => `${named.join("\n")}\n`);
}

async function run(project: string, action: string, json: boolean, argv: string[]): Promise<number> {
  if (!process.features.typescript) {
    return relaunchStrippingTypes(argv);
  }

  const report = await runAction(workspace(), project, action);

  return emit(json, report, () => asSummary(report));
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

/** What a Run captured, and what it left behind. */
function asSummary(report: RunReport): string {
  const { captured, repeated } = report.frames;
  const seconds = (captured / report.framerate).toFixed(2);

  return [
    `${report.project} ${report.action}`,
    `  ${captured} Frames at ${report.framerate}fps (${seconds}s), ${repeated} repeated`,
    ...report.artifacts.map(
      (artifact) => `  ${artifact.format}  ${artifact.width}x${artifact.height}  ${artifact.path}`,
    ),
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
