/**
 * A Project's configuration, as the app owns it.
 *
 * Action code is agent-owned and this is the other half: everything a Project
 * says about itself in `project.toml` -- where it answers, how it is started,
 * what its clips are photographed at, and whether they are ever made public.
 *
 * Every setting there is is an entry in the registry below, so adding one is
 * adding an entry: the command lists it, the app draws a control for it, and
 * the same declaration decides what it will take. Nothing outside this file
 * names a setting.
 *
 * A change is written into the file the Project is already configured in, one
 * line at a time (`toml.ts`), so the notes a person left in it survive being
 * edited from the app. It is held against the reader first, and refused in
 * words that say what to send instead -- a setting the tool would not take must
 * fail here, where the file still says what it said, rather than at record time
 * with the refusal already saved.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { parse as parseToml } from "smol-toml";

import {
  actionsDirectory,
  configFile,
  projectFromToml,
  readProject,
  type ProjectConfig,
} from "./config.js";
import { RecordError } from "./errors.js";
import { mockupNames } from "./mockup.js";
import { editToml, type TomlEdit, type TomlValue } from "./toml.js";

/** What a setting is worth, and so what kind of control it is tuned with. */
export type SettingKind = "text" | "number" | "choice" | "flag";

/** One setting of a Project, with what it is worth and what it will take. */
export type ReportedSetting = {
  /** The name it is written under in `project.toml`, tables and all. */
  readonly name: string;
  readonly kind: SettingKind;
  /** Written for whoever is configuring the Project, so it is shown to them. */
  readonly describes: string;
  /** A Project cannot record without it, so it is changed and never emptied. */
  readonly required: boolean;
  /** The range a number is configured within, and nothing for the other kinds. */
  readonly min?: number;
  readonly max?: number;
  /** The values a choice takes, so that setting it is picking rather than spelling. */
  readonly choices?: readonly string[];
  /** What the Project records with, whether the file says it or the tool stands it in. */
  readonly value: TomlValue | null;
  /** Whether the file says it, rather than the tool standing a value in. */
  readonly written: boolean;
};

/** Everything the app owns about one Project, and where it is written down. */
export type ProjectReport = {
  readonly project: string;
  /** The file it is configured in, comments and all. */
  readonly file: string;
  /** What the Project is configured with, exactly as every command reads it. */
  readonly configured: ProjectConfig;
  readonly settings: readonly ReportedSetting[];
};

/** One setting: what it is called, what it takes, and what stands where it is unsaid. */
type SettingDeclaration = {
  readonly name: string;
  readonly kind: SettingKind;
  readonly describes: string;
  readonly required: boolean;
  readonly min?: number;
  readonly max?: number;
  /** Whether it counts something -- a pixel, a millisecond -- and so has no halves. */
  readonly whole?: boolean;
  readonly choices?: readonly string[];
  /** What the Project records with, which is the default where the file is silent. */
  reads(project: ProjectConfig): TomlValue | null;
  /** Whatever is wrong with a value that only this machine can be asked about. */
  refuses?(value: TomlValue): Promise<string | undefined>;
};

/** How wide or tall a viewport or an Artifact can sensibly be asked for, in pixels. */
const widestPixels = 7680;

/**
 * Every setting a Project has. The order is the order they are shown in, which
 * is where it answers, how it is started, what it is photographed at, and then
 * what becomes of the clips.
 */
const declared: readonly SettingDeclaration[] = [
  {
    name: "base_url",
    kind: "text",
    describes: "Where the Project answers on this machine",
    required: true,
    reads: (project) => project.baseUrl,
    refuses: servedUrl,
  },
  {
    name: "ready_path",
    kind: "text",
    describes: "Path under the base URL that answers when the Project is ready to record",
    required: false,
    reads: (project) => project.readyPath,
    refuses: aPath,
  },
  {
    name: "start_command",
    kind: "text",
    describes: "Command that starts the Project when it is not already answering",
    required: false,
    reads: (project) => project.startCommand ?? null,
  },
  {
    name: "working_directory",
    kind: "text",
    describes: "Where that command runs",
    required: false,
    reads: (project) => project.workingDirectory ?? null,
    refuses: aDirectory,
  },
  {
    name: "ready_timeout_ms",
    kind: "number",
    describes: "How long a Project that had to be started is given to answer",
    required: false,
    min: 100,
    max: 600_000,
    whole: true,
    reads: (project) => project.readyTimeoutMs,
  },
  {
    name: "source_repository",
    kind: "text",
    describes: "The Project's own repository, read to report staleness and never written to",
    required: true,
    reads: (project) => project.sourceRepository,
    refuses: aDirectory,
  },
  {
    name: "viewport.width",
    kind: "number",
    describes: "How wide the page is photographed, in CSS pixels",
    required: false,
    min: 1,
    max: widestPixels,
    whole: true,
    reads: (project) => project.viewport.width,
  },
  {
    name: "viewport.height",
    kind: "number",
    describes: "...and how tall",
    required: false,
    min: 1,
    max: widestPixels,
    whole: true,
    reads: (project) => project.viewport.height,
  },
  {
    name: "viewport.device_scale_factor",
    kind: "number",
    describes: "How many device pixels each CSS pixel is captured as",
    required: false,
    min: 0.5,
    max: 4,
    reads: (project) => project.viewport.deviceScaleFactor,
  },
  {
    name: "video_width",
    kind: "number",
    describes: "Width the video Artifacts are encoded at",
    required: false,
    min: 2,
    max: widestPixels,
    whole: true,
    reads: (project) => project.videoWidth,
  },
  {
    name: "mockup",
    kind: "choice",
    describes: "The Mockup composited around this Project's clips, which an Action may override",
    required: false,
    choices: mockupNames,
    reads: (project) => project.mockup,
  },
  // A theme hook is deliberately not one of these. It is a pair of expressions
  // that a Project declares both of or neither, and a setting is changed one at
  // a time -- so the first half of a pair would be refused every time, and a
  // control that can only fail is worse than a file somebody edits by hand.
  {
    name: "published",
    kind: "flag",
    describes: "Whether this Project's Latest clips are ever made public -- ADR 0007",
    required: false,
    reads: (project) => project.published,
  },
];

/** A Project is named for the directory it is configured in, so its name is one. */
const nameable = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What one Project is configured with, and what each of its settings will take. */
export async function readConfiguration(workspace: string, project: string): Promise<ProjectReport> {
  const file = configFile(workspace, project);

  return report(project, file, await readProject(workspace, project), await readFile(file, "utf8"));
}

/**
 * Changes settings written as `name=value`, in the file the Project is already
 * configured in -- comments, spacing and hand-written notes and all.
 *
 * A setting given nothing at all is taken out of the file, and what the tool
 * stands in stands again. One a Project cannot do without is refused instead:
 * an emptied `base_url` is a Project that cannot be recorded, which is a worse
 * answer than the one it had.
 */
export async function configureProject(
  workspace: string,
  project: string,
  assignments: readonly string[],
): Promise<ProjectReport> {
  const file = configFile(workspace, project);
  // Read first, so a Project that is not configured is answered by the Project
  // rather than by a file that could not be opened.
  await readProject(workspace, project);

  const text = await readFile(file, "utf8");
  const edits = await editsFor(assignments);
  const written = editToml(text, edits);

  // Held to exactly what a Run holds the file to, before any of it is saved.
  const configured = wouldRead(project, written, file);

  await writeFile(file, written, "utf8");

  return report(project, file, configured, written);
}

/**
 * Configures a new Project, which is never Published: publishing is the one
 * outward-facing thing this tool does (ADR 0007), so it is turned on
 * deliberately, on a Project that already exists and has clips to look at.
 *
 * Nothing is created until the whole configuration is one a Run could read, so
 * a name refused leaves no half-made directory behind.
 */
export async function addProject(
  workspace: string,
  name: string,
  assignments: readonly string[],
): Promise<ProjectReport> {
  if (!nameable.test(name)) {
    throw new RecordError(
      `a Project is named for the directory it is configured in, and '${name}' is not a name ` +
        "one can have: letters, digits, dashes, dots and underscores",
    );
  }

  const file = configFile(workspace, name);

  if (await isThere(file)) {
    throw new RecordError(`a Project named '${name}' is already configured in ${file}`);
  }

  const edits = await editsFor(assignments);

  for (const edit of edits) {
    if (edit.path.join(".") === "published") {
      throw new RecordError(
        "a new Project is never Published, so 'published' is turned on once there are clips " +
          "to look at -- ADR 0007",
      );
    }
  }

  const missing = declared
    .filter((setting) => setting.required)
    .filter((setting) => !edits.some((edit) => edit.path.join(".") === setting.name))
    .map((setting) => setting.name);

  if (missing.length > 0) {
    throw new RecordError(`a Project is configured with ${missing.join(" and ")} at the least`);
  }

  const written = editToml(opening(name), edits);
  const configured = wouldRead(name, written, file);

  await mkdir(actionsDirectory(workspace, name), { recursive: true });
  await writeFile(file, written, "utf8");

  return report(name, file, configured, written);
}

/**
 * The Project a document would configure, or why it would configure none.
 *
 * Read exactly as a Run reads the file, and said in the same words -- but as
 * something that would be rather than something that is, because the file on
 * disk still says what it said and is about not to be written.
 */
function wouldRead(project: string, written: string, file: string): ProjectConfig {
  try {
    return projectFromToml(project, written, file);
  } catch (failure) {
    throw new RecordError(
      `that change was refused rather than written, because ${(failure as Error).message}`,
    );
  }
}

/**
 * What a new Project's file says before anything is written into it: what it is
 * for, and that it is not Published. The ones it cannot do without are written
 * empty and then set, so that every value in the file arrives the same way --
 * and so that a Project growing a required setting grows a line for it here.
 */
function opening(name: string): string {
  return `${[
    `# ${name}, as this tool records it. Every setting here is editable in the app,`,
    "# and anything written by hand survives an edit made through it.",
    "",
    ...declared.filter((setting) => setting.required).map((setting) => `${setting.name} = ""`),
    "",
    "# Off unless deliberately turned on -- ADR 0007.",
    "published = false",
  ].join("\n")}\n`;
}

/** The changes `name=value` asks for, refusing any this tool will not take. */
async function editsFor(assignments: readonly string[]): Promise<readonly TomlEdit[]> {
  const edits: TomlEdit[] = [];

  for (const assignment of assignments) {
    const at = assignment.indexOf("=");

    if (at <= 0) {
      throw new RecordError(`a setting is written name=value, not '${assignment}'`);
    }

    const name = assignment.slice(0, at);
    const setting = settingNamed(name);
    const value = await valueFor(setting, assignment.slice(at + 1));

    edits.push({ path: name.split("."), value });
  }

  return edits;
}

/** One setting by name, or a message naming the ones a Project has. */
function settingNamed(name: string): SettingDeclaration {
  const setting = declared.find((one) => one.name === name);

  if (setting === undefined) {
    throw new RecordError(
      `'${name}' is not a setting a Project has. It has ` +
        declared.map((one) => one.name).join(", "),
    );
  }

  return setting;
}

/**
 * What one setting is to say, as the text it was written as -- or nothing at
 * all, which is the value being taken out and the tool's own standing again.
 */
async function valueFor(setting: SettingDeclaration, text: string): Promise<TomlValue | undefined> {
  if (text === "") {
    if (setting.required) {
      throw new RecordError(
        `'${setting.name}' is one a Project cannot record without, so it is changed rather ` +
          "than emptied",
      );
    }
    return undefined;
  }

  const value = shapeOf(setting, text);
  const refused = await setting.refuses?.(value);

  if (refused !== undefined) {
    throw new RecordError(`'${setting.name}': ${refused}`);
  }

  return value;
}

/** A value of the shape the setting takes, or a message saying what it takes instead. */
function shapeOf(setting: SettingDeclaration, text: string): TomlValue {
  if (setting.kind === "choice") {
    const choices = setting.choices ?? [];

    if (!choices.includes(text)) {
      throw new RecordError(`'${setting.name}' takes one of ${choices.join(", ")}, not '${text}'`);
    }
    return text;
  }

  if (setting.kind === "flag") {
    if (text !== "true" && text !== "false") {
      throw new RecordError(`'${setting.name}' takes true or false, not '${text}'`);
    }
    return text === "true";
  }

  if (setting.kind === "text") {
    // A line break would leave the file saying something no line of it says.
    if (/\p{Cc}/u.test(text)) {
      throw new RecordError(`'${setting.name}' takes one line of text, and that is more than one`);
    }
    return text;
  }

  const value = Number(text);
  const { min = -Infinity, max = Infinity } = setting;

  if (text.trim() === "" || !Number.isFinite(value)) {
    throw new RecordError(`'${setting.name}' takes a number, not '${text}'`);
  }
  if (value < min || value > max) {
    throw new RecordError(`'${setting.name}' takes a number between ${min} and ${max}, not ${value}`);
  }
  // A pixel and a millisecond are counted, and there is no half of either.
  if (setting.whole === true && !Number.isInteger(value)) {
    throw new RecordError(`'${setting.name}' counts in whole numbers, and ${value} is not one`);
  }

  return value;
}

/** Where a Project answers, which is a URL this machine could fetch. */
async function servedUrl(value: TomlValue): Promise<string | undefined> {
  let url: URL;

  try {
    url = new URL(String(value));
  } catch {
    return `'${String(value)}' is not a URL, so nothing could be recorded at it`;
  }

  return url.protocol === "http:" || url.protocol === "https:"
    ? undefined
    : `a Project is recorded over http or https, not ${url.protocol}`;
}

/** A path under the base URL, which is a path rather than a name beside one. */
async function aPath(value: TomlValue): Promise<string | undefined> {
  return String(value).startsWith("/")
    ? undefined
    : `'${String(value)}' is read against the base URL rather than under it, so it begins with /`;
}

/**
 * A directory this machine has. A path that is not there is a typo, and finding
 * that out when a Run will not start is finding it out too late.
 */
async function aDirectory(value: TomlValue): Promise<string | undefined> {
  const path = String(value);
  const found = await stat(path).catch(() => undefined);

  if (found === undefined) {
    return `there is nothing at '${path}' on this machine`;
  }

  return found.isDirectory() ? undefined : `'${path}' is a file rather than a directory`;
}

/** What the Project records with, and which of it the file actually says. */
function report(
  project: string,
  file: string,
  configured: ProjectConfig,
  text: string,
): ProjectReport {
  // Read again rather than reasoned about: whether a setting is written down is
  // a fact about the file, and the configuration cannot tell a value written by
  // hand from the same value standing in.
  const table = parseToml(text) as Record<string, unknown>;

  return {
    project,
    file,
    configured,
    settings: declared.map((setting) => ({
      name: setting.name,
      kind: setting.kind,
      describes: setting.describes,
      required: setting.required,
      ...(setting.min === undefined ? {} : { min: setting.min }),
      ...(setting.max === undefined ? {} : { max: setting.max }),
      ...(setting.choices === undefined ? {} : { choices: setting.choices }),
      value: setting.reads(configured),
      written: says(table, setting.name.split(".")),
    })),
  };
}

/** Whether the document says a key at all, table by table. */
function says(table: Record<string, unknown>, path: readonly string[]): boolean {
  let said: unknown = table;

  for (const part of path) {
    if (typeof said !== "object" || said === null) {
      return false;
    }
    said = (said as Record<string, unknown>)[part];
  }

  return said !== undefined;
}

async function isThere(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}
