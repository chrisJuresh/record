#!/usr/bin/env node
/**
 * The `record` command. The CLI is the real interface: the server and the UI
 * reach the tool through these commands rather than around them.
 */
import { resolve } from "node:path";

import { readActions, readProjects, RecordError, type ProjectConfig } from "@record/core";

const usage = `record -- repeatable clips of locally-running websites

  record projects              List every configured Project
  record actions <project>     List a Project's Actions

  --json                       Emit machine-readable output
  --help                       Show this message

The workspace holding projects/ is $RECORD_WORKSPACE, or this checkout.`;

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
