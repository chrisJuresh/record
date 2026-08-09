/**
 * Project configuration. Every Project this tool knows about is a directory
 * under `projects/` in the workspace holding a `project.toml` -- per ADR 0003
 * nothing is ever written into the Project's own repository.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { RecordError } from "./errors.js";

export type Viewport = {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
};

export type ProjectConfig = {
  /** The directory the Project is configured in, which is also its name. */
  readonly name: string;
  readonly baseUrl: string;
  /** Path under `baseUrl` that answers when the Project is ready to record. */
  readonly readyPath: string;
  /** Command that starts the Project when it is not already answering. */
  readonly startCommand?: string;
  readonly workingDirectory?: string;
  /** The Project's own git repository, read to report staleness. */
  readonly sourceRepository: string;
  readonly viewport: Viewport;
  /** Off unless deliberately turned on -- ADR 0007. */
  readonly published: boolean;
};

const defaultReadyPath = "/";
const defaultViewport: Viewport = { width: 1440, height: 900, deviceScaleFactor: 2 };

/** Every configured Project in the workspace, by name. */
export async function readProjects(workspace: string): Promise<ProjectConfig[]> {
  const names = (await readdir(projectsDirectory(workspace), { withFileTypes: true }).catch(asMissing))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return Promise.all(names.map((name) => readProject(workspace, name)));
}

/** One configured Project, or a failure naming the Project that is not there. */
export async function readProject(workspace: string, name: string): Promise<ProjectConfig> {
  const file = join(projectsDirectory(workspace), name, "project.toml");

  const text = await readFile(file, "utf8").catch((failure: NodeJS.ErrnoException) => {
    if (failure.code === "ENOENT") {
      throw new RecordError(`no Project named '${name}' is configured in ${projectsDirectory(workspace)}`);
    }
    throw failure;
  });

  let table: unknown;
  try {
    table = parseToml(text);
  } catch (failure) {
    throw new RecordError(`${file} is not valid TOML: ${(failure as Error).message}`);
  }

  return projectFrom(name, table as Record<string, unknown>, file);
}

/** The names of a Project's Actions. */
export async function readActions(workspace: string, name: string): Promise<string[]> {
  await readProject(workspace, name);

  const entries = await readdir(join(projectsDirectory(workspace), name, "actions"), {
    withFileTypes: true,
  }).catch(asMissing);

  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === ".ts")
    .map((entry) => entry.name.slice(0, -".ts".length))
    .sort();
}

function projectsDirectory(workspace: string): string {
  return join(workspace, "projects");
}

function projectFrom(name: string, table: Record<string, unknown>, file: string): ProjectConfig {
  const viewport = optionalTable(table, "viewport", file) ?? {};
  const startCommand = optionalString(table, "start_command", file);
  const workingDirectory = optionalString(table, "working_directory", file);

  return {
    name,
    baseUrl: requiredString(table, "base_url", file),
    readyPath: optionalString(table, "ready_path", file) ?? defaultReadyPath,
    ...(startCommand === undefined ? {} : { startCommand }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    sourceRepository: requiredString(table, "source_repository", file),
    viewport: {
      width: optionalNumber(viewport, "width", file) ?? defaultViewport.width,
      height: optionalNumber(viewport, "height", file) ?? defaultViewport.height,
      deviceScaleFactor:
        optionalNumber(viewport, "device_scale_factor", file) ?? defaultViewport.deviceScaleFactor,
    },
    published: optionalBoolean(table, "published", file) ?? false,
  };
}

function requiredString(table: Record<string, unknown>, key: string, file: string): string {
  const value = optionalString(table, key, file);
  if (value === undefined) {
    throw new RecordError(`${file} is missing '${key}'`);
  }
  return value;
}

function optionalString(table: Record<string, unknown>, key: string, file: string): string | undefined {
  return expect(table[key], "a string", (value) => typeof value === "string", key, file);
}

function optionalNumber(table: Record<string, unknown>, key: string, file: string): number | undefined {
  return expect(table[key], "a number", (value) => typeof value === "number", key, file);
}

function optionalBoolean(table: Record<string, unknown>, key: string, file: string): boolean | undefined {
  return expect(table[key], "true or false", (value) => typeof value === "boolean", key, file);
}

function optionalTable(
  table: Record<string, unknown>,
  key: string,
  file: string,
): Record<string, unknown> | undefined {
  return expect(
    table[key],
    "a table",
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    key,
    file,
  );
}

function expect<T>(
  value: unknown,
  expected: string,
  holds: (value: unknown) => boolean,
  key: string,
  file: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!holds(value)) {
    throw new RecordError(`${file}: '${key}' must be ${expected}`);
  }
  return value as T;
}

/** A directory that is not there holds no entries; anything else is a real failure. */
function asMissing(failure: NodeJS.ErrnoException): never[] {
  if (failure.code === "ENOENT") {
    return [];
  }
  throw failure;
}
