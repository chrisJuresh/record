/**
 * The server, as the app talks to it.
 *
 * Every answer here is `record` invoked on the other side of loopback, so the
 * types below are what the command says about a Project, an Action or a Run --
 * as much of each answer as the app reads, and no more. They are declared rather
 * than imported because the app runs in a browser and the tool's own packages
 * are Node's: a shared type would drag the engine into the page.
 *
 * Nothing here decides anything. A failure is passed on in the command's own
 * words, because the difference between a stale selector and a Project that
 * would not start is the whole of what a failure is for.
 */

/** One configured Project, in as much as the rail shows of it. */
export type Project = {
  readonly name: string;
  readonly baseUrl: string;
  readonly published: boolean;
};

/** What one of a Project's settings is worth. */
export type SettingValue = string | number | boolean;

/**
 * One setting of a Project, with what it is worth and what it will take.
 *
 * Which settings there are is the command's answer rather than a list kept
 * here: a Project grows a setting by the tool growing one, and the app draws a
 * control for whatever it is told about.
 */
export type Setting = {
  /** The name it is written under in `project.toml`, tables and all. */
  readonly name: string;
  readonly kind: "text" | "number" | "choice" | "flag";
  /** Written for whoever is configuring the Project, so it is shown to them. */
  readonly describes: string;
  /** A Project cannot record without it, so it is changed and never emptied. */
  readonly required: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly choices?: readonly string[];
  /** What it records with, whether the file says it or the tool stands it in. */
  readonly value: SettingValue | null;
  /** Whether the file says it, rather than the tool standing a value in. */
  readonly written: boolean;
};

/** Everything a Project is configured with, and where it is written down. */
export type ProjectReport = {
  readonly project: string;
  /** The file it is configured in, comments and all. */
  readonly file: string;
  /** The Project as every command now reads it, which is what the rail shows. */
  readonly configured: Project;
  readonly settings: readonly Setting[];
};

export type Artifact = {
  readonly format: "mp4" | "webm" | "gif";
  /** Where it is on this machine. Its last segment is what it is served as. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly durationMs: number;
};

/** One Run of an Action, and what it left behind. */
export type Run = {
  readonly project: string;
  readonly action: string;
  /** What the Run is called, which is also the directory it is served from. */
  readonly id: string;
  readonly recordedAt: string;
  readonly commit: string | null;
  /** The Condition a Matrix recorded it under, and nothing where it varied none. */
  readonly condition: { readonly name: string } | null;
  readonly framerate: number;
  readonly frames: { readonly captured: number };
  /** What the Action ran with, declarations and Overrides together. */
  readonly parameters: Readonly<Record<string, ParameterSetting>>;
  /** Which of those came from an Override rather than from the declaration. */
  readonly overridden: readonly string[];
  readonly artifacts: readonly Artifact[];
  /** Where the embed snippet naming both video Artifacts was written. */
  readonly embed: string;
};

/** What a Parameter is worth once it has been resolved. */
export type ParameterSetting = number | string | boolean;

/** One declared Parameter, with what it is currently worth and why. */
export type Parameter = {
  readonly name: string;
  readonly kind: "number" | "easing" | "choice" | "flag";
  /** Written for whoever is tuning it, so it is shown to them. */
  readonly describes: string;
  readonly default: ParameterSetting;
  /** The range a number is tuned within, and nothing for the other kinds. */
  readonly min?: number;
  readonly max?: number;
  /** The values a choice or an easing takes, so that tuning it is picking one. */
  readonly choices?: readonly string[];
  readonly value: ParameterSetting;
  readonly overridden: boolean;
};

/** Everything tunable about one Action, and anything wrong with its sidecar. */
export type ParameterReport = {
  readonly project: string;
  readonly action: string;
  /** Where the Overrides are kept, whether or not there are any yet. */
  readonly sidecar: string;
  readonly parameters: readonly Parameter[];
  /**
   * Overrides that could not be applied -- a value the Action would refuse, or a
   * Parameter it no longer declares. Said rather than dropped, because an Action
   * rewritten out from under its sidecar would otherwise run quietly differently
   * from how it reads.
   */
  readonly warnings: readonly string[];
};

/** The viewport a Project is photographed at, which is what a Preview is shown at. */
export type Viewport = {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
};

/**
 * Where the page is on one Frame. As much of a Frame as a Preview replays --
 * a Preview shows no drawn cursor and no keystroke captions, so it reads the
 * scroll position and nothing else.
 */
export type FrameState = {
  readonly scrollTop: number;
};

/** What a Preview of an Action would need, as the command answers it. */
export type PreviewReport = {
  readonly previewable: boolean;
  /** Which primitive stops it, in the command's own words. */
  readonly refusal: string | null;
  readonly baseUrl: string;
  readonly readyUrl: string;
  readonly viewport: Viewport;
};

/**
 * What an Action's Timeline evaluates to. The app replays this and evaluates
 * nothing of its own: an easing implemented here would be a second
 * implementation of one, and two that agree today are two that will silently
 * disagree later.
 */
export type TimelineReport = {
  readonly project: string;
  readonly action: string;
  readonly framerate: number;
  readonly durationMs: number;
  readonly frames: number;
  readonly states: readonly FrameState[];
  /** Which Parameters did not take their value from the declaration. */
  readonly overridden: readonly string[];
  /** ...and which were evaluated as if they applied, and written nowhere. */
  readonly named: readonly string[];
  readonly warnings: readonly string[];
  readonly preview: PreviewReport;
};

/** A Preview turned on: the Timeline it replays, and where the Project is proxied. */
export type PreviewTurnedOn = {
  readonly project: string;
  readonly action: string;
  /** The Preview origin, which is what the frame on the stage is opened at. */
  readonly origin: string;
  readonly timeline: TimelineReport;
};

/** How one Action stands against its Project, as the command reports it. */
export type ActionStatus = {
  readonly action: string;
  /**
   * Whether the Project has been committed to since that Action last ran. Read
   * from the command rather than worked out here: what counts as Stale is one
   * rule, and it lives where `record status` answers.
   */
  readonly stale: boolean;
};

export type ProjectStatus = {
  readonly project: string;
  /** What its repository is at now, or nothing where there is no commit to read. */
  readonly commit: string | null;
  readonly actions: readonly ActionStatus[];
};

/** Which Actions have gone Stale, and what could not be told either way. */
export type StatusReport = {
  readonly projects: readonly ProjectStatus[];
  /**
   * Staleness that could not be told -- a Project under no repository, or an
   * Action last recorded when there was no commit to read. Carried in the
   * command's own words, because "not Stale" and "cannot say" are not the same
   * answer and only one of them means the clip is current.
   */
  readonly warnings: readonly string[];
};

/** One file a publish would make public, and how big it would be once it was. */
export type PublishedFile = {
  /** Where it lands in this repository, which is also the URL it is linked by. */
  readonly path: string;
  readonly bytes: number;
  /** The Artifact on this machine it is copied from. */
  readonly from: string;
};

/** What one Action contributes: the Artifacts of its Latest, and when that ran. */
export type PublishedAction = {
  readonly action: string;
  /** The Condition that Latest was recorded under, and nothing for the Action's own. */
  readonly condition: string | null;
  readonly recordedAt: string;
  readonly files: readonly PublishedFile[];
};

export type PublishedProject = {
  readonly project: string;
  readonly actions: readonly PublishedAction[];
};

/**
 * Exactly what publishing would make public: which Projects, which files, how
 * big each of them is, and what would be taken back out. Nothing is confirmed
 * by anyone who has not been shown this, which is the whole of why it is a
 * report rather than a yes-or-no.
 */
export type PublishPlan = {
  readonly directory: string;
  readonly projects: readonly PublishedProject[];
  readonly files: readonly PublishedFile[];
  readonly removing: readonly string[];
  readonly bytes: number;
  /** What the plan could not account for, in the command's own words. */
  readonly warnings: readonly string[];
};

/** The plan, and what became of it -- the same answer whether or not it ran. */
export type PublishReport = {
  readonly plan: PublishPlan;
  readonly published: boolean;
  readonly commit: string | null;
  /** The branch that commit was made on, which is the branch that was pushed. */
  readonly branch: string | null;
  readonly pushed: boolean;
};

/**
 * What a Run says about itself while it is still running. It says more than this
 * -- the Condition it is recording under, and what stopped it on the stage that
 * says one did -- and how a Run ended is read from the request ending rather
 * than from the last thing it said on the way.
 */
export type Progress = {
  readonly project: string;
  readonly action: string;
  readonly stage: "starting" | "capturing" | "encoding" | "recorded" | "failed";
  readonly frames?: { readonly captured: number; readonly of: number };
};

/** One Run that failed, named beside the others that recorded regardless. */
export type Failure = {
  readonly project: string;
  readonly action: string;
  readonly message: string;
};

/** What recording several Actions produced, and what it could not. */
export type Summary = {
  readonly runs: readonly Run[];
  readonly failures: readonly Failure[];
};

/** One request to record, as the server reads it back. */
export type Request = {
  readonly id: string;
  readonly state: "running" | "recorded" | "failed";
  /** A Run's own report, or the summary of several -- whichever was asked for. */
  readonly report: unknown;
  /** What stopped it, in the command's own words. */
  readonly message: string | null;
};

/** What to record: one Action, every Action of a Project, or everything. */
export type Ask = {
  readonly project?: string;
  readonly action?: string;
  readonly all?: boolean;
};

/** Told what a Run is doing, and then how it ended. */
export type Watching = {
  progress(progress: Progress): void;
  ended(request: Request): void;
  /** The server stopped saying, which is not a Run that failed. */
  lost(): void;
};

export function projects(): Promise<readonly Project[]> {
  return read<readonly Project[]>(["api", "projects"]);
}

export function actions(project: string): Promise<readonly string[]> {
  return read<readonly string[]>(["api", "projects", project, "actions"]);
}

/** What one Project is configured with, and what each of its settings will take. */
export function configuration(project: string): Promise<ProjectReport> {
  return read<ProjectReport>(["api", "projects", project]);
}

/**
 * Changes settings written as `name=value`, and answers with what the Project
 * will now record with -- read from the answer rather than assumed, since a
 * setting the tool refuses was never written down. A setting given nothing at
 * all is taken out of the file, and what the tool stands in stands again.
 */
export function configure(
  project: string,
  settings: readonly string[],
): Promise<ProjectReport> {
  return wrote<ProjectReport>(["api", "projects", project], { set: settings });
}

/** Configures a Project this workspace does not have yet, which is never Published. */
export function add(project: string, settings: readonly string[]): Promise<ProjectReport> {
  return wrote<ProjectReport>(["api", "projects"], { project, set: settings });
}

/** Every Run of an Action still kept on this machine, newest first. */
export function history(project: string, action: string): Promise<readonly Run[]> {
  return read<readonly Run[]>(["api", "history", project, action]);
}

/**
 * Which Actions of this workspace have gone Stale. Asked for every Project at
 * once, because it is one command and the rail flags all of them.
 */
export function status(): Promise<StatusReport> {
  return read<StatusReport>(["api", "status"]);
}

/**
 * What publishing would make public. Reading it makes nothing public: it is the
 * plan, and confirming it is a separate request that says so outright.
 */
export function publishPlan(): Promise<PublishReport> {
  return read<PublishReport>(["api", "publish"]);
}

/**
 * ...and carrying that plan out, which commits and pushes this repository and
 * nothing else. The one irreversible, outward-facing thing the app does.
 */
export function publish(): Promise<PublishReport> {
  return wrote<PublishReport>(["api", "publish"], { confirm: true });
}

/** What an Action declares, what it is tuned to, and what it will run with. */
export function parameters(project: string, action: string): Promise<ParameterReport> {
  return read<ParameterReport>(parametersOf(project, action));
}

/**
 * Records Overrides written as `name=value`, and answers with what the Action
 * will now run with -- which is read from the answer rather than assumed, since
 * a value the Action refuses was never written down.
 */
export function set(
  project: string,
  action: string,
  assignments: readonly string[],
): Promise<ParameterReport> {
  return wrote<ParameterReport>(parametersOf(project, action), { set: assignments });
}

/** Removes Overrides by name, leaving what the Action declares. */
export function reset(
  project: string,
  action: string,
  names: readonly string[],
): Promise<ParameterReport> {
  return wrote<ParameterReport>([...parametersOf(project, action), "reset"], { reset: names });
}

function parametersOf(project: string, action: string): readonly string[] {
  return ["api", "projects", project, "actions", action, "parameters"];
}

/**
 * What an Action's Timeline evaluates to, optionally under values that have not
 * been settled on.
 *
 * Named values are evaluated as if they applied and written nowhere, which is
 * what makes scrubbing a slider possible without leaving forty Overrides in the
 * sidecar behind it. Settling on one is `set`, exactly as it is today.
 */
export function timeline(
  project: string,
  action: string,
  named: readonly string[] = [],
): Promise<TimelineReport> {
  return read<TimelineReport>(["api", "timeline", project, action], named.map((set) => ["set", set]));
}

/**
 * Turns a Preview on: the Timeline to replay, and the origin the Project is
 * proxied at so that the page can be driven from here.
 *
 * The command refuses an Action that clicks, types, evaluates or waits, and a
 * Project that is not answering -- both in its own words. Nothing here decides
 * either: a Preview drives a live site, and the rule that protects one lives in
 * the tool.
 */
export function preview(project: string, action: string): Promise<PreviewTurnedOn> {
  return wrote<PreviewTurnedOn>(["api", "preview"], { project, action });
}

/**
 * Asks for a recording, which is answered as soon as it has been asked for
 * rather than when it is done -- what it does next is watched.
 */
export function record(ask: Ask): Promise<Request> {
  return wrote<Request>(["api", "runs"], ask);
}

/**
 * Watches one request to the end, and stops watching when the returned function
 * is called.
 *
 * The stream ends with the Run, and a stream that ended is not one to reconnect
 * to: the server would catch a new watcher up on a Run that is long over and
 * close on it again, for as long as the page stayed open.
 */
export function watch(id: string, watching: Watching): () => void {
  const source = new EventSource(url(["api", "runs", id, "events"]));
  const stop = (): void => source.close();

  source.addEventListener("progress", (event) => {
    watching.progress(said<Progress>(event));
  });

  for (const state of ["recorded", "failed"] as const) {
    source.addEventListener(state, (event) => {
      stop();
      watching.ended(said<Request>(event));
    });
  }

  // A stream that dropped is retried by the browser, and the server catches a
  // watcher up rather than showing it what was left of the Run -- so only a
  // stream it has given up on is worth saying anything about.
  source.addEventListener("error", () => {
    if (source.readyState === EventSource.CLOSED) {
      watching.lost();
    }
  });

  return stop;
}

/** Where one Artifact of a Run is served, which is where a clip is played from. */
export function artifactUrl(run: Run, artifact: Artifact): string {
  return runFileUrl(run, artifact.path);
}

/** Where the embed snippet a Run wrote beside its Artifacts is served. */
export function embedUrl(run: Run): string {
  return runFileUrl(run, run.embed);
}

/**
 * One file of a Run, by the name it has inside the Run's own directory. The
 * Artifacts of a Condition are named apart and kept apart, so both belong to
 * the path rather than being derived from the Action.
 */
function runFileUrl(run: Run, path: string): string {
  const file = path.split(/[\\/]/).at(-1) ?? "";
  const under = run.condition === null ? [] : ["conditions", run.condition.name];

  return url(["artifacts", run.project, run.action, ...under, run.id, file]);
}

/**
 * A path this server answers, spelled so that no name in it can become part of
 * it -- and whatever is asked of it, spelled the same way.
 */
function url(segments: readonly string[], asked: readonly (readonly [string, string])[] = []): string {
  const path = `/${segments.map(encodeURIComponent).join("/")}`;
  const query = new URLSearchParams(asked.map(([name, value]) => [name, value])).toString();

  return query === "" ? path : `${path}?${query}`;
}

async function read<Answer>(
  segments: readonly string[],
  asked: readonly (readonly [string, string])[] = [],
): Promise<Answer> {
  return answered<Answer>(
    await fetch(url(segments, asked), { headers: { accept: "application/json" } }),
  );
}

/** Asks the server to write something, and reads back what the command answered. */
async function wrote<Answer>(segments: readonly string[], body: unknown): Promise<Answer> {
  return answered<Answer>(
    await fetch(url(segments), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * What the server said, or a failure carrying what it said instead. The API
 * answers a refusal with the command's own message, so that is what is thrown.
 */
async function answered<Answer>(response: Response): Promise<Answer> {
  const text = await response.text();

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(response.ok ? "the server answered something unreadable" : text.trim());
  }

  if (!response.ok) {
    const said = (value as { error?: unknown }).error;
    throw new Error(typeof said === "string" ? said : text.trim());
  }

  return value as Answer;
}

/** What one server-sent event carried. */
function said<Event>(event: globalThis.Event): Event {
  return JSON.parse((event as MessageEvent<string>).data) as Event;
}
