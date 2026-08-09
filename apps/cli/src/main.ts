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

  const json = argv.includes("--json");
  const [command, ...operands] = argv.filter((argument) => !argument.startsWith("-"));

  try {
    switch (command) {
      case "projects":
        return await projects(json);
      case "actions":
        return await actions(operands[0], json);
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

  process.stdout.write(json ? `${JSON.stringify(configured, null, 2)}\n` : describe(configured));
  return 0;
}

async function actions(project: string | undefined, json: boolean): Promise<number> {
  if (project === undefined) {
    return fail(`actions needs the name of a Project\n\n${usage}`);
  }

  const named = await readActions(workspace(), project);

  process.stdout.write(json ? `${JSON.stringify(named, null, 2)}\n` : `${named.join("\n")}\n`);
  return 0;
}

/** One line per Project: its name, where it serves, and whether it is Published. */
function describe(configured: ProjectConfig[]): string {
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
