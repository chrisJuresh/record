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
  readonly artifacts: readonly Artifact[];
  /** Where the embed snippet naming both video Artifacts was written. */
  readonly embed: string;
};

/** What a Run says about itself while it is still running. */
export type Progress = {
  readonly project: string;
  readonly action: string;
  readonly condition: string | null;
  readonly stage: "starting" | "capturing" | "encoding" | "recorded" | "failed";
  readonly frames?: { readonly captured: number; readonly of: number };
  readonly message?: string;
};

/** One Run that failed, named beside the others that recorded regardless. */
export type Failure = {
  readonly project: string;
  readonly action: string;
  readonly condition: string | null;
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

/** Every Run of an Action still kept on this machine, newest first. */
export function history(project: string, action: string): Promise<readonly Run[]> {
  return read<readonly Run[]>(["api", "history", project, action]);
}

/**
 * Asks for a recording, which is answered as soon as it has been asked for
 * rather than when it is done -- what it does next is watched.
 */
export async function record(ask: Ask): Promise<Request> {
  return answered<Request>(
    await fetch(url(["api", "runs"]), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ask),
    }),
  );
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

/** A path this server answers, spelled so that no name in it can become part of it. */
function url(segments: readonly string[]): string {
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

async function read<Answer>(segments: readonly string[]): Promise<Answer> {
  return answered<Answer>(await fetch(url(segments), { headers: { accept: "application/json" } }));
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
