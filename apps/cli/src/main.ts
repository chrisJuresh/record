#!/usr/bin/env node
/**
 * The `record` command. The CLI is the real interface: the server and the UI
 * reach the tool through these commands rather than around them.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { startServer } from "@record/server";

import {
  actionModule,
  conditionsFor,
  defaultConcurrency,
  mockups,
  noMockup,
  readActions,
  readConditions,
  readHistory,
  readParameters,
  readProjects,
  readStatus,
  RecordError,
  renderContactSheet,
  resetOverrides,
  runAction,
  runActions,
  setOverrides,
  type Condition,
  type ContactSheetReport,
  type ParameterReport,
  type ProjectConfig,
  type RunProgress,
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
  record history <project> <action> <condition>    ...of one Matrix Condition
  record mockups                         List every Mockup a clip can be shown in
  record mockups <project> <action>      Render every Mockup around a Frame of an Action
  record serve                           Serve these operations over HTTP, on this machine only

  --set <name>=<value>         Override a Parameter for this Run, and keep it
  --all                        Record every Project rather than one named Project
  --scheme <light,dark>        Record across colour schemes, as a Matrix
  --width <n,n>                Record at several viewport widths, as a Matrix
  --concurrency <n>            How many Runs record at once (${defaultConcurrency})
  --progress                   Say what a Run is doing, on stderr, as it does it
  --at <seconds>               How far into an Action the contact sheet photographs (0)
  --port <n>                   The loopback port to serve on (an ephemeral one)
  --json                       Emit machine-readable output
  --help                       Show this message

A Matrix records one request across varied conditions, each Run kept and named
apart -- '--scheme light,dark' writes <action>-light and <action>-dark. Given
together they multiply, so '--scheme light,dark --width 480,1200' is four Runs.

The workspace holding projects/ is $RECORD_WORKSPACE, or this checkout.`;

/** Commands that import an Action module, and so need a Node that reads TypeScript. */
const readsActions = ["run", "parameters", "set", "reset", "mockups"];

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

  const { command, operands, json, sets, all, schemes, widths, concurrency, at, port, progress } =
    parsed;

  for (const [option, given] of [
    ["--set", sets.length > 0],
    ["--all", all],
    ["--scheme", schemes.length > 0],
    ["--width", widths.length > 0],
    ["--concurrency", concurrency !== undefined],
    ["--progress", progress],
  ] as const) {
    if (given && command !== "run") {
      return fail(`only run takes ${option}\n\n${usage}`);
    }
  }

  if (at !== undefined && command !== "mockups") {
    return fail(`only mockups takes --at\n\n${usage}`);
  }

  if (port !== undefined && command !== "serve") {
    return fail(`only serve takes --port\n\n${usage}`);
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
        // Read once there is something to record it against, so that a command
        // naming no Project is answered about the Project rather than about a
        // Matrix it was never going to get as far as.
        const matrix = conditionsFor({ schemes, widths });

        // ...and one Action on its own records once, however many the machine
        // could have recorded beside it. Under a Matrix it records several
        // times, and how many at once is worth asking for again.
        if (concurrency !== undefined && action !== undefined && matrix.length === 0) {
          return fail(
            "--concurrency is how many Runs record at once, so it takes a Project, --all, " +
              `or a Matrix\n\n${usage}`,
          );
        }

        // Written before anything records, so that tuning survives a Run that
        // fails -- and once for the Action rather than once per Condition, an
        // Override belonging to the Action rather than to what it records
        // under. Not warned about here: the Runs are about to read the same
        // sidecar and say the same thing, and saying it twice reads as two
        // problems.
        if (sets.length > 0 && project !== undefined && action !== undefined) {
          await setOverrides(workspace(), project, action, sets);
        }

        // A Matrix is several Runs however few Actions it names, so even one
        // Action reports as the summary of what a request produced.
        return project !== undefined && action !== undefined && matrix.length === 0
          ? await run(project, action, progress, json)
          : await runEvery(project, action, matrix, concurrency, progress, json);
      }
      case "status": {
        const [project] = operands;
        if (operands.length > 1) {
          return fail(`status takes at most the name of one Project\n\n${usage}`);
        }
        return await status(project, json);
      }
      case "history": {
        const [project, action, condition] = operands;
        if (project === undefined || action === undefined || operands.length > 3) {
          return fail(
            "history takes the name of one Project, one of its Actions, and at most one " +
              `Condition\n\n${usage}`,
          );
        }
        return await history(project, action, condition, json);
      }
      case "mockups": {
        const [project, action] = operands;
        if (operands.length === 0) {
          return listMockups(json);
        }
        if (project === undefined || action === undefined || operands.length > 2) {
          return fail(
            `mockups takes nothing, or one Project and one of its Actions\n\n${usage}`,
          );
        }
        return await contactSheet(project, action, at, json);
      }
      case "serve": {
        if (operands.length > 0) {
          return fail(`serve takes no arguments\n\n${usage}`);
        }
        return await serve(port, json);
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
  /** The colour schemes a Matrix records across, as they were typed. */
  readonly schemes: readonly string[];
  /** The viewport widths a Matrix records at, as they were typed. */
  readonly widths: readonly string[];
  /** How many Runs record at once, or nothing when the default stands. */
  readonly concurrency: number | undefined;
  /** How far into an Action a contact sheet photographs, in seconds. */
  readonly at: number | undefined;
  /** The loopback port to serve on, or nothing for an ephemeral one. */
  readonly port: number | undefined;
  /** Whether a Run says what it is doing while it is doing it. */
  readonly progress: boolean;
};

/** The command, its operands, and the options it was given, or a message about one it was not. */
function parse(argv: string[]): Arguments {
  const words: string[] = [];
  const sets: string[] = [];
  const schemes: string[] = [];
  const widths: string[] = [];
  let json = false;
  let all = false;
  let progress = false;
  let concurrency: number | undefined;
  let at: number | undefined;
  let port: number | undefined;

  for (let position = 0; position < argv.length; position++) {
    const argument = argv[position] ?? "";

    if (argument === "--json") {
      json = true;
    } else if (argument === "--all") {
      all = true;
    } else if (argument === "--progress") {
      progress = true;
    } else if (argument === "--set") {
      const assignment = argv[++position];
      if (assignment === undefined) {
        throw new Error("--set takes name=value");
      }
      sets.push(assignment);
    } else if (argument === "--scheme") {
      schemes.push(...listed(argv[++position], "--scheme"));
    } else if (argument === "--width") {
      widths.push(...listed(argv[++position], "--width"));
    } else if (argument === "--concurrency") {
      concurrency = runsAtOnce(argv[++position]);
    } else if (argument === "--at") {
      at = instantOf(argv[++position]);
    } else if (argument === "--port") {
      port = portOf(argv[++position]);
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option '${argument}'`);
    } else {
      words.push(argument);
    }
  }

  const [command = "", ...operands] = words;

  return { command, operands, json, sets, all, schemes, widths, concurrency, at, port, progress };
}

/**
 * What one Matrix option names, which is a comma-separated list -- and may be
 * given more than once, so that a long Matrix reads as several options rather
 * than one line nobody can pick apart. What each entry means is the domain's
 * business; that there is at least one is this option's.
 */
function listed(given: string | undefined, option: string): string[] {
  const entries = (given ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length === 0) {
    throw new Error(`${option} takes a comma-separated list, not '${given ?? ""}'`);
  }

  return entries;
}

/** How many Runs happen at once, which is a count of Runs rather than a number. */
function runsAtOnce(given: string | undefined): number {
  const count = Number(given);

  if (given === undefined || !Number.isInteger(count) || count < 1) {
    throw new Error(`--concurrency takes how many Runs record at once, not '${given ?? ""}'`);
  }

  return count;
}

/** The port to serve on, which is a port a machine has -- 0 asks for any free one. */
function portOf(given: string | undefined): number {
  const port = Number(given);

  if (given === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port takes the port to serve on, not '${given ?? ""}'`);
  }

  return port;
}

/** How far into a clip something happens, which is somewhere within it. */
function instantOf(given: string | undefined): number {
  const seconds = Number(given);

  if (given === undefined || given.trim() === "" || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`--at takes how far into the Action to photograph, not '${given ?? ""}'`);
  }

  return seconds;
}

async function projects(json: boolean): Promise<number> {
  const configured = await readProjects(workspace());

  return emit(json, configured, () => asTable(configured));
}

async function actions(project: string, json: boolean): Promise<number> {
  const named = await readActions(workspace(), project);

  return emit(json, named, () => `${named.join("\n")}\n`);
}

/** One Action recorded on its own, which is what a request varying nothing asks for. */
async function run(
  project: string,
  action: string,
  progress: boolean,
  json: boolean,
): Promise<number> {
  const recorded = await runAction(workspace(), project, action, watching(progress));
  warnAbout(recorded.warnings);

  return emit(json, recorded, () => asRun(recorded));
}

/**
 * Records every Action of one Project, or of every Project, or one named Action
 * across a Matrix's Conditions -- several at once.
 *
 * A Run that failed does not take the others down with it, so the command fails
 * while still reporting everything that recorded -- and what stopped each one is
 * said on stderr whichever output was asked for, because a failure is exactly
 * what must not pass unnoticed.
 */
async function runEvery(
  project: string | undefined,
  action: string | undefined,
  conditions: readonly Condition[],
  concurrency: number | undefined,
  progress: boolean,
  json: boolean,
): Promise<number> {
  const recorded = await runActions(workspace(), {
    ...(project === undefined ? {} : { project }),
    ...(action === undefined ? {} : { action }),
    ...(conditions.length === 0 ? {} : { conditions }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...watching(progress),
  });

  warnAbout(recorded.runs.flatMap((run) => run.warnings));

  for (const failure of recorded.failures) {
    const under = failure.condition === null ? "" : ` (${failure.condition})`;
    process.stderr.write(`failed: ${failure.project} ${failure.action}${under}: ${failure.message}\n`);
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

/**
 * The Runs of one Action still kept on this machine, newest first -- or of one
 * of its Conditions, which keeps a history of its own rather than being folded
 * into the Action's.
 */
async function history(
  project: string,
  action: string,
  condition: string | undefined,
  json: boolean,
): Promise<number> {
  // Asked of the Action first: an Action nobody has run has no history, which
  // is a different answer from a name nobody declared.
  await actionModule(workspace(), project, action);

  const kept = await readHistory(workspace(), project, action, condition);
  // Named only where the Action's own Runs were asked for: a Condition's
  // history is one stream, and pointing from it back at its siblings is noise.
  const conditions =
    condition === undefined ? await readConditions(workspace(), project, action) : [];

  return emit(json, kept, () => asHistory(kept, conditions));
}

/**
 * Every Mockup a clip can be shown in. Read without a Project, a browser or a
 * Run: choosing a surround starts with knowing which ones there are.
 */
function listMockups(json: boolean): number {
  const offered = Object.values(mockups).map((mockup) => ({
    name: mockup.name,
    describes: mockup.describes,
    backdrop: mockup.backdrop,
  }));

  const name = widest(offered.map((mockup) => mockup.name));

  return emit(json, offered, () =>
    offered.map((mockup) => `${mockup.name.padEnd(name)}  ${mockup.describes}\n`).join(""),
  );
}

/**
 * Every Mockup around one Frame of an Action, so that a surround is chosen by
 * looking at it rather than by reading about it.
 */
async function contactSheet(
  project: string,
  action: string,
  at: number | undefined,
  json: boolean,
): Promise<number> {
  const rendered = await renderContactSheet(workspace(), project, action, {
    ...(at === undefined ? {} : { at }),
  });

  return emit(json, rendered, () => asContactSheet(rendered));
}

/**
 * Serves these same operations over HTTP, bound to loopback, until it is
 * stopped. The server invokes this command for everything it answers, which is
 * why there is no second implementation of any of it to keep in step.
 *
 * The URL is said as soon as it is bound, because whatever started the server
 * has to know where to open.
 */
async function serve(port: number | undefined, json: boolean): Promise<number> {
  const running = await startServer({
    workspace: workspace(),
    // The command that started it, so the server invokes exactly this build of
    // it rather than whichever `record` this machine would find.
    command: { executable: process.execPath, entry: [import.meta.filename] },
    ...(port === undefined ? {} : { port }),
  });

  process.stdout.write(
    json
      ? `${JSON.stringify({ url: running.url, port: running.port })}\n`
      : `record is serving at ${running.url}\n`,
  );

  // Serving is the command: it holds the process open until it is interrupted,
  // and stops the Runs it started on the way out.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void running.close().then(() => {
        process.exit(0);
      });
    });
  }

  return 0;
}

/** Where each rendering went, and the page that shows them together. */
function asContactSheet(rendered: ContactSheetReport): string {
  const name = widest(rendered.mockups.map((entry) => entry.mockup));

  return [
    `${rendered.project} ${rendered.action}  Frame ${rendered.frame} at ${rendered.at}s`,
    ...rendered.mockups.map(
      (entry) =>
        `  ${entry.mockup.padEnd(name)}  ${`${entry.width}x${entry.height}`.padEnd(9)}  ${entry.image}`,
    ),
    `  sheet ${rendered.page}`,
    "",
  ].join("\n");
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
 * How a Run says what it is doing while it is doing it, or nothing at all where
 * nobody asked -- one line of JSON per progress, on stderr, under a prefix of
 * its own. Progress shares stderr with warnings and failures because stdout is
 * the command's answer, and it is prefixed so that whatever is watching can
 * tell the three apart.
 */
function watching(progress: boolean): { progress?: (event: RunProgress) => void } {
  return progress
    ? {
        progress: (event) => {
          process.stderr.write(`progress: ${JSON.stringify(event)}\n`);
        },
      }
    : {};
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

/** One line per Parameter: what it is worth now, what it would be, and what it takes. */
function asParameters(reported: ParameterReport): string {
  const name = widest(reported.parameters.map((parameter) => parameter.name));
  const value = widest(reported.parameters.map((parameter) => String(parameter.value)));

  return reported.parameters
    .map((parameter) => {
      const source = parameter.overridden ? `  overridden, default ${parameter.default}` : "";

      return `${parameter.name.padEnd(name)}  ${String(parameter.value).padEnd(value)}${takes(parameter)}${source}\n`;
    })
    .join("");
}

/** What one Parameter will take: a range, a set of names, or nothing to say. */
function takes(parameter: ParameterReport["parameters"][number]): string {
  if (parameter.min !== undefined) {
    return `  (${parameter.min}..${parameter.max})`;
  }
  return parameter.choices === undefined ? "" : `  (${parameter.choices.join("|")})`;
}

/** What a Run captured, and what it left behind. */
function asRun(report: RunReport): string {
  const { captured, repeated } = report.frames;
  const seconds = (captured / report.framerate).toFixed(2);

  const { readyUrl, started } = report.lifecycle;

  return [
    `${report.project} ${report.action}${report.condition === null ? "" : ` (${report.condition.name})`}`,
    started
      ? `  started the Project at ${readyUrl}, and stopped it again`
      : `  recorded the Project already answering at ${readyUrl}`,
    `  ${captured} Frames at ${report.framerate}fps (${seconds}s), ${repeated} repeated`,
    ...asCondition(report),
    ...asCursor(report),
    ...asMockup(report),
    ...asText(report),
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
 * The Condition a Matrix recorded this Run under, and nothing at all for a Run
 * asked for on its own.
 *
 * How the scheme was put is worth saying, and so is what the page then reads
 * as: a Project told that dark is preferred and photographed light is a site
 * that has no dark theme, and that is a fact about the site rather than a
 * failure of the Run.
 */
function asCondition(report: RunReport): string[] {
  const { condition } = report;

  if (condition === null) {
    return [];
  }

  const varied = [
    ...(condition.scheme === null
      ? []
      : [
          `${condition.scheme} by ${condition.switched === "hook" ? "the Project's theme hook" : "emulated colour-scheme"}` +
            `, and the page reads ${report.mockup.colourScheme}`,
        ]),
    ...(condition.width === null ? [] : [`${condition.width} CSS pixels wide`]),
  ];

  return [`  recorded ${varied.join(", ")}`];
}

/**
 * What was drawn over the page, and nothing at all where nothing was: an Action
 * that only scrolls draws no cursor, and a line saying so every time would say
 * it about most Runs.
 */
function asCursor(report: RunReport): string[] {
  const drawn = [
    ...(report.cursor.shown ? [`a ${report.cursor.style} cursor`] : []),
    ...(report.cursor.captions ? ["captioned keystrokes"] : []),
  ];

  return drawn.length === 0 ? [] : [`  drew ${drawn.join(" and ")}`];
}

/**
 * The surround the Frames were composited into, and nothing at all where they
 * were composited into none. A Mockup the page chose says so, because the
 * choice was not written down anywhere the operator can read it.
 */
function asMockup(report: RunReport): string[] {
  if (report.mockup.name === noMockup) {
    return [];
  }

  const chosen =
    report.mockup.asked === report.mockup.name
      ? ""
      : ` (${report.mockup.asked}, and the page reads ${report.mockup.colourScheme})`;

  return [`  inside the ${report.mockup.name} Mockup${chosen}`];
}

/**
 * The copy substituted into the page, and nothing at all for the Actions that
 * substituted none -- which is most of them. What each selector matched is
 * worth saying: one that matched more than the wording was meant for is a
 * clip nobody has looked at yet.
 */
function asText(report: RunReport): string[] {
  if (report.text.length === 0) {
    return [];
  }

  const elements = report.text.reduce((total, substitution) => total + substitution.matched, 0);

  return [`  substituted copy for ${many(report.text.length, "selector")}, ` +
    `into ${many(elements, "element")}`];
}

/** A count and what it counts, said so that one of something reads as one. */
function many(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What each Run recorded, and a tally of how it went -- the Runs that failed
 * are named on stderr rather than a second time here, because one failure said
 * twice reads as two.
 */
function asRuns(recorded: RunSummary): string {
  const asked = recorded.runs.length + recorded.failures.length;
  const across =
    recorded.conditions.length === 0 ? "" : ` across ${recorded.conditions.join(", ")}`;

  return [
    ...recorded.runs.map(asRun),
    `${recorded.runs.length} of ${asked} Runs recorded${across}, ${recorded.concurrency} at a time\n`,
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

/**
 * One line per retained Run, newest first: when it ran, against what, and how
 * it was tuned -- followed by the Conditions that keep histories of their own,
 * so that a Matrix's Runs are findable rather than merely kept.
 */
function asHistory(kept: readonly RunReport[], conditions: readonly string[]): string {
  return [
    ...kept.map((run) => {
      const commit = run.commit === null ? "no commit" : shortCommit(run.commit);
      const tuned = run.overridden.length === 0 ? "" : `  overridden: ${run.overridden.join(", ")}`;

      return `${run.recordedAt}  ${commit}  ${run.frames.captured} Frames at ${run.framerate}fps${tuned}\n`;
    }),
    ...(conditions.length === 0 ? [] : [`also recorded under ${conditions.join(", ")}\n`]),
  ].join("");
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
