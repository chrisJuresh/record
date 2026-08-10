/**
 * Project configuration. Every Project this tool knows about is a directory
 * under `projects/` in the workspace holding a `project.toml` -- per ADR 0003
 * nothing is ever written into the Project's own repository.
 */
import { access, readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { RecordError } from "./errors.js";
import { automaticMockup, mockupNames } from "./mockup.js";

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
  /** How long a Project that had to be started is given to answer its ready URL. */
  readonly readyTimeoutMs: number;
  /** The Project's own git repository, read to report staleness. */
  readonly sourceRepository: string;
  readonly viewport: Viewport;
  /** Width the video Artifacts are encoded at, below the captured viewport. */
  readonly videoWidth: number;
  /**
   * The Mockup composited around this Project's clips, which every one of its
   * Actions carries as the default of a Parameter it can override.
   */
  readonly mockup: string;
  /** Off unless deliberately turned on -- ADR 0007. */
  readonly published: boolean;
};

const defaultReadyPath = "/";
/** Long enough for a bundler to build a site it has not built before. */
const defaultReadyTimeoutMs = 60_000;
const defaultViewport: Viewport = { width: 1440, height: 900, deviceScaleFactor: 2 };
const defaultVideoWidth = 1280;

/**
 * Every configured Project in the workspace, by name. A directory holding no
 * `project.toml` configures no Project, so a scratch directory left under
 * `projects/` does not take the whole listing down.
 */
export async function readProjects(workspace: string): Promise<ProjectConfig[]> {
  const entries = await readdir(projectsDirectory(workspace), { withFileTypes: true }).catch(asMissing);

  const configured = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ((await isReadable(configFile(workspace, entry.name))) ? entry.name : undefined)),
  );

  const names = configured.filter((name) => name !== undefined).sort();

  return Promise.all(names.map((name) => readProject(workspace, name)));
}

/** One configured Project, or a failure naming the Project that is not there. */
export async function readProject(workspace: string, name: string): Promise<ProjectConfig> {
  const file = configFile(workspace, name);

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

  const entries = await readdir(actionsDirectory(workspace, name), {
    withFileTypes: true,
  }).catch(asMissing);

  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === ".ts")
    .map((entry) => entry.name.slice(0, -".ts".length))
    .sort();
}

/** The module declaring one of a Project's Actions, or a failure naming it. */
export async function actionModule(workspace: string, project: string, action: string): Promise<string> {
  const file = join(actionsDirectory(workspace, project), `${action}.ts`);

  return access(file).then(
    () => file,
    () => {
      throw new RecordError(`no Action named '${action}' is declared by Project '${project}'`);
    },
  );
}

/**
 * The sidecar holding one Action's Overrides. It sits beside the module rather
 * than inside it so that regenerating an Action cannot destroy tuning and
 * tuning cannot corrupt code (ADR 0005).
 */
export function overridesFile(workspace: string, project: string, action: string): string {
  return join(actionsDirectory(workspace, project), `${action}.overrides.toml`);
}

function projectsDirectory(workspace: string): string {
  return join(workspace, "projects");
}

function actionsDirectory(workspace: string, project: string): string {
  return join(projectsDirectory(workspace), project, "actions");
}

function configFile(workspace: string, name: string): string {
  return join(projectsDirectory(workspace), name, "project.toml");
}

async function isReadable(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
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
    readyTimeoutMs: optionalNumber(table, "ready_timeout_ms", file) ?? defaultReadyTimeoutMs,
    sourceRepository: requiredString(table, "source_repository", file),
    viewport: {
      width: optionalNumber(viewport, "width", file) ?? defaultViewport.width,
      height: optionalNumber(viewport, "height", file) ?? defaultViewport.height,
      deviceScaleFactor:
        optionalNumber(viewport, "device_scale_factor", file) ?? defaultViewport.deviceScaleFactor,
    },
    videoWidth: optionalNumber(table, "video_width", file) ?? defaultVideoWidth,
    mockup: chosenMockup(table, file),
    published: optionalBoolean(table, "published", file) ?? false,
  };
}

/**
 * The Mockup this Project's clips are shown in. A name that is not one of them
 * is refused here, where the message can name the file it was written in --
 * every Action of the Project would otherwise fail one at a time.
 */
function chosenMockup(table: Record<string, unknown>, file: string): string {
  const chosen = optionalString(table, "mockup", file) ?? automaticMockup;

  if (!mockupNames.includes(chosen)) {
    throw new RecordError(
      `${file}: 'mockup' is '${chosen}', which is not one of ${mockupNames.join(", ")}`,
    );
  }

  return chosen;
}

function requiredString(table: Record<string, unknown>, key: string, file: string): string {
  const value = optionalString(table, key, file);
  if (value === undefined) {
    throw new RecordError(`${file} is missing '${key}'`);
  }
  return value;
}

function optionalString(table: Record<string, unknown>, key: string, file: string): string | undefined {
  return ofType(table, key, file, "a string", (value) => typeof value === "string");
}

function optionalNumber(table: Record<string, unknown>, key: string, file: string): number | undefined {
  return ofType(table, key, file, "a number", (value) => typeof value === "number");
}

function optionalBoolean(table: Record<string, unknown>, key: string, file: string): boolean | undefined {
  return ofType(table, key, file, "true or false", (value) => typeof value === "boolean");
}

function optionalTable(
  table: Record<string, unknown>,
  key: string,
  file: string,
): Record<string, unknown> | undefined {
  return ofType(
    table,
    key,
    file,
    "a table",
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  );
}

/** A key's value if it is there and of the expected type, and a message naming both if it is not. */
function ofType<T>(
  table: Record<string, unknown>,
  key: string,
  file: string,
  expected: string,
  isExpected: (value: unknown) => boolean,
): T | undefined {
  const value = table[key];

  if (value === undefined) {
    return undefined;
  }
  if (!isExpected(value)) {
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
