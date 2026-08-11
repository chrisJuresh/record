/**
 * The local HTTP server: the same operations the command offers, over loopback,
 * with a Run's progress streamed while it is in flight.
 *
 * It holds no recording logic of its own. Every answer here is the `record`
 * command invoked and read back, which is most of the reason the command is the
 * real interface -- there is one implementation behind the UI, the command line
 * and any agent session, and no second place for a rule about Projects, Runs or
 * Artifacts to live.
 *
 * It binds loopback and nothing else (ADR 0002), and it answers only requests
 * addressed to a loopback name: a page on the open internet must not be able to
 * reach a tool that starts processes on this machine.
 */
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { serveApp } from "./app.js";
import { serveArtifact } from "./artifacts.js";
import { CommandFailed, invoke, type RecordChild, type RecordCommand } from "./command.js";
import { runRegistry, type RunEvent } from "./runs.js";

/** The only interface this server will bind. Not an option: see ADR 0002. */
const loopback = "127.0.0.1";

/** The host names a request may be addressed to, all of them this machine. */
const loopbackNames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** As much of a request body as a run request could possibly need. */
const largestBody = 64 * 1024;

export type ServerOptions = {
  /** How `record` is invoked, since invoking it is all this server does. */
  readonly command: RecordCommand;
  /** The workspace whose Projects are served, and whose Runs are played back. */
  readonly workspace: string;
  /**
   * The directory the app is served out of, which the command that starts this
   * server names -- the app is part of the tool rather than of the workspace, so
   * where it is is known by the thing that was installed.
   */
  readonly app: string;
  /** The loopback port to bind, or an ephemeral one where none is asked for. */
  readonly port?: number;
};

export type RunningServer = {
  readonly url: string;
  readonly port: number;
  /** Stops serving, and stops the Runs this server started. */
  close(): Promise<void>;
};

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const runs = runRegistry();
  /** The commands this server has running, so closing it does not orphan them. */
  const children = new Set<RecordChild>();

  const server = createServer((request, response) => {
    void handle(request, response, { options, runs, children }).catch(() => {
      if (!response.headersSent) {
        answer(response, 500, { error: "the server could not answer that" });
        return;
      }
      response.destroy();
    });
  });

  server.listen(options.port ?? 0, loopback);
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server did not bind a TCP port");
  }

  return {
    url: `http://${loopback}:${address.port}/`,
    port: address.port,
    async close() {
      for (const child of children) {
        child.kill();
      }
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** Everything one request needs, gathered rather than reached for. */
type Serving = {
  readonly options: ServerOptions;
  readonly runs: ReturnType<typeof runRegistry>;
  readonly children: Set<RecordChild>;
};

/** Keeps hold of a command while it runs, so closing the server does not orphan it. */
function holding(serving: Serving): (child: RecordChild) => void {
  return (child) => {
    serving.children.add(child);
    child.once("close", () => serving.children.delete(child));
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  serving: Serving,
): Promise<void> {
  // A request addressed to anything but this machine reached it by a name
  // resolving here, which is how a page elsewhere would drive a local tool.
  if (!addressedHere(request.headers.host)) {
    return answer(response, 403, { error: "this server answers loopback requests only" });
  }

  const url = new URL(request.url ?? "/", `http://${loopback}`);
  const method = request.method ?? "GET";

  let segments: string[];
  try {
    segments = url.pathname
      .split("/")
      .filter((segment) => segment !== "")
      .map(decodeURIComponent);
  } catch {
    return answer(response, 400, { error: "that path is not readable" });
  }

  const [section, ...path] = segments;

  // The app is what this server is opened at, and everything not addressed to
  // the API or to an Artifact is part of it. Those two are the reserved names,
  // so a file the app grows later needs nothing added here.
  if (section === undefined || (section !== "api" && section !== "artifacts")) {
    return serveApp(response, serving.options.app, segments, method);
  }

  if (section === "artifacts") {
    if (method !== "GET" && method !== "HEAD") {
      return answer(response, 405, { error: `an Artifact is fetched, not ${method}` });
    }

    return serveArtifact(response, serving.options.workspace, path, {
      range: request.headers.range,
      method,
    });
  }

  // Everything below is the command, invoked and read back. Which command each
  // path names is the whole of the mapping: nothing here decides an answer.
  const [asked, ...under] = path;

  if (asked === undefined) {
    return get(request, response, () => answer(response, 200, index(serving)));
  }

  if (asked === "projects") {
    return projects(request, response, serving, under);
  }

  if (asked === "runs") {
    return runs(request, response, serving, under);
  }

  if (asked === "mockups" && under.length === 0) {
    return get(request, response, () => command(response, serving, ["mockups"]));
  }

  if (asked === "status" && under.length === 0) {
    const project = url.searchParams.get("project");

    return get(request, response, () =>
      command(response, serving, ["status", ...(project === null ? [] : [project])]),
    );
  }

  // A Project, one of its Actions, and at most one Condition -- which is what
  // the command takes, so it is handed on rather than picked apart here.
  if (asked === "history" && (under.length === 2 || under.length === 3)) {
    return get(request, response, () => command(response, serving, ["history", ...under]));
  }

  return answer(response, 404, { error: "nothing is served at that path" });
}

/**
 * What is read about a Project -- its Actions, and one Action's Parameters --
 * and what is written of one Action's tuning.
 */
function projects(
  request: IncomingMessage,
  response: ServerResponse,
  serving: Serving,
  under: readonly string[],
): void | Promise<void> {
  const [project, actions, action, parameters, reset] = under;

  if (under.length === 0) {
    return get(request, response, () => command(response, serving, ["projects"]));
  }

  if (under.length === 2 && project !== undefined && actions === "actions") {
    return get(request, response, () => command(response, serving, ["actions", project]));
  }

  if (
    project === undefined ||
    actions !== "actions" ||
    action === undefined ||
    parameters !== "parameters"
  ) {
    return answer(response, 404, { error: "nothing is served at that path" });
  }

  // Reading what an Action is tuned to, and writing it: the same Parameters, so
  // the same path, and which command it comes to is the method.
  if (under.length === 4) {
    return request.method === "POST"
      ? tune(request, response, serving, "set", project, action)
      : get(request, response, () => command(response, serving, ["parameters", project, action]));
  }

  // Removing an Override is its own command rather than setting one to nothing,
  // because what is left is what the Action declares.
  if (under.length === 5 && reset === "reset") {
    return request.method === "POST"
      ? tune(request, response, serving, "reset", project, action)
      : answer(response, 405, { error: "an Override is reset by POST, not read" });
  }

  answer(response, 404, { error: "nothing is served at that path" });
}

/**
 * Writes one Action's tuning: the Overrides to set, or the ones to remove.
 *
 * Both answer with the report the command gives for itself, so whatever asked
 * reads what the Action will now run with rather than assuming it got what it
 * sent -- and a value the Action refuses is answered in the command's own words,
 * since "outside the declared range 1..120" is what says what to send instead.
 */
async function tune(
  request: IncomingMessage,
  response: ServerResponse,
  serving: Serving,
  asked: "set" | "reset",
  project: string,
  action: string,
): Promise<void> {
  const body = await jsonIn(request);

  if ("error" in body) {
    return answer(response, 400, { error: body.error });
  }

  const named = namesFor(body.said, asked);

  if ("error" in named) {
    return answer(response, 400, { error: named.error });
  }

  return command(response, serving, [asked, project, action, ...named.names]);
}

/**
 * What a request to tune names: `name=value` for each Override to set, or the
 * name of each to remove. What the command will take of them is the command's
 * own business; that a request said any at all is this one's.
 */
function namesFor(
  body: unknown,
  asked: "set" | "reset",
): { readonly names: readonly string[] } | { readonly error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: `a request to ${asked} is an object saying what to ${asked}` };
  }

  const named = (body as Record<string, unknown>)[asked];

  if (asked === "set") {
    const written = overridesIn(named);

    return "error" in written ? { error: written.error } : { names: written.set };
  }

  if (!Array.isArray(named) || named.length === 0 || named.some((entry) => !isName(entry))) {
    return { error: "'reset' is the names of Overrides to remove" };
  }

  return { names: named as string[] };
}

/**
 * The `name=value` Overrides a request names, wherever one names them -- the same
 * check for a request to record with them as for a request to write them, since
 * it is the same list on the way to the same command.
 */
function overridesIn(value: unknown): { readonly set: readonly string[] } | { readonly error: string } {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => !isName(entry) || !entry.includes("="))
  ) {
    return { error: "'set' is a list of 'name=value' Overrides" };
  }

  return { set: value as string[] };
}

/**
 * Whether something a request said is a name the command can be handed. A name
 * beginning with a dash would reach the command as an option rather than as what
 * it names, which is the one thing a request must not be able to smuggle in.
 */
function isName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.startsWith("-");
}

/** The Runs this server has been asked for: asking for one, reading one, watching one. */
function runs(
  request: IncomingMessage,
  response: ServerResponse,
  serving: Serving,
  under: readonly string[],
): void | Promise<void> {
  const [id, events] = under;

  if (under.length === 0) {
    if (request.method === "POST") {
      return record(request, response, serving);
    }

    return get(request, response, () => answer(response, 200, serving.runs.all()));
  }

  if (under.length === 1 && id !== undefined) {
    const asked = serving.runs.read(id);

    return get(request, response, () =>
      asked === undefined
        ? answer(response, 404, { error: "no Run was asked for under that name" })
        : answer(response, 200, asked),
    );
  }

  if (under.length === 2 && id !== undefined && events === "events") {
    return get(request, response, () => stream(request, response, serving, id));
  }

  answer(response, 404, { error: "nothing is served at that path" });
}

/** What this server offers, for whoever is reading the API rather than the app. */
function index(serving: Serving): unknown {
  return {
    record: "serving this machine only",
    workspace: serving.options.workspace,
    endpoints: [
      "GET  /  the app",
      "GET  /api/projects",
      "GET  /api/projects/<project>/actions",
      "GET  /api/projects/<project>/actions/<action>/parameters",
      "POST /api/projects/<project>/actions/<action>/parameters",
      "POST /api/projects/<project>/actions/<action>/parameters/reset",
      "GET  /api/mockups",
      "GET  /api/status[?project=<project>]",
      "GET  /api/history/<project>/<action>[/<condition>]",
      "GET  /api/runs",
      "POST /api/runs",
      "GET  /api/runs/<id>",
      "GET  /api/runs/<id>/events",
      "GET  /artifacts/<project>/<action>/<run>/<file>",
      "GET  /artifacts/<project>/<action>/conditions/<condition>/<run>/<file>",
    ],
  };
}

/**
 * A request to record, answered as soon as it has been asked for rather than
 * when it is done: a Run takes long enough that holding the connection open for
 * it would be the hang this is meant to prevent. What it does next is read from
 * its own path, or watched as it happens.
 */
async function record(
  request: IncomingMessage,
  response: ServerResponse,
  serving: Serving,
): Promise<void> {
  const body = await jsonIn(request);

  if ("error" in body) {
    return answer(response, 400, { error: body.error });
  }

  const asked = wordsFor(body.said);

  if ("error" in asked) {
    return answer(response, 400, { error: asked.error });
  }

  const begun = serving.runs.begin(asked.words);

  // Not awaited: the answer goes back now and the Runs go on without it.
  void invoke({
    command: serving.options.command,
    workspace: serving.options.workspace,
    words: asked.words,
    progress: (event) => {
      serving.runs.progress(begun.id, event);
    },
    started: holding(serving),
  }).then(
    (report) => {
      serving.runs.end(begun.id, { state: "recorded", report, message: null });
    },
    (failure: unknown) => {
      // The command's own words, rather than a generic error: a Run that failed
      // because a selector went stale reads nothing like one that failed
      // because the Project would not start.
      serving.runs.end(begun.id, {
        state: "failed",
        report: failure instanceof CommandFailed ? failure.answered : undefined,
        message: failure instanceof Error ? failure.message : String(failure),
      });
    },
  );

  answer(response, 202, begun);
}

/** What a request to record comes to as the command's own words, or what is wrong with it. */
function wordsFor(body: unknown): { readonly words: readonly string[] } | { readonly error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "a request to record is an object saying what to record" };
  }

  const asked = body as Record<string, unknown>;
  const words: string[] = [];

  for (const name of ["project", "action"] as const) {
    const value = asked[name];

    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string" || value === "" || value.startsWith("-")) {
      return { error: `'${String(value)}' is not the name of a ${name}` };
    }

    words.push(value);
  }

  if (asked["all"] === true) {
    words.push("--all");
  }

  for (const [name, option] of [
    ["schemes", "--scheme"],
    ["widths", "--width"],
  ] as const) {
    const value = asked[name];

    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      return { error: `'${name}' is the list of Conditions to record across` };
    }
    if (value.length > 0) {
      words.push(option, value.join(","));
    }
  }

  const concurrency = asked["concurrency"];
  if (concurrency !== undefined) {
    if (typeof concurrency !== "number" || !Number.isInteger(concurrency)) {
      return { error: "'concurrency' is how many Runs record at once" };
    }
    words.push("--concurrency", String(concurrency));
  }

  const sets = asked["set"];
  if (sets !== undefined) {
    const written = overridesIn(sets);

    if ("error" in written) {
      return { error: written.error };
    }
    for (const assignment of written.set) {
      words.push("--set", assignment);
    }
  }

  // What the command takes and what it refuses is the command's own business,
  // and its message is what a client is shown when it refuses.
  return { words: ["run", ...words, "--json", "--progress"] };
}

/**
 * A Run's progress as it happens, as server-sent events -- which is the one
 * thing a browser reads a stream of without being written any code to.
 *
 * A watcher joining late is caught up first, so what it reads is the whole Run
 * rather than whatever was left of it.
 */
function stream(
  request: IncomingMessage,
  response: ServerResponse,
  serving: Serving,
  id: string,
): void {
  if (serving.runs.read(id) === undefined) {
    return answer(response, 404, { error: "no Run was asked for under that name" });
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  // A HEAD asks how this would be answered, not to be held open until the Run
  // is over -- so it is told, and let go.
  if (request.method === "HEAD") {
    return void response.end();
  }

  const send = (event: RunEvent): void => {
    if (event.kind === "progress") {
      response.write(`event: progress\ndata: ${JSON.stringify(event.progress)}\n\n`);
      return;
    }

    response.write(`event: ${event.request.state}\ndata: ${JSON.stringify(event.request)}\n\n`);
    response.end();
  };

  const stop = serving.runs.watch(id, send);
  request.on("close", stop);
}

/** Invokes the command and answers with what it said, either way. */
async function command(
  response: ServerResponse,
  serving: Serving,
  words: readonly string[],
): Promise<void> {
  try {
    answer(
      response,
      200,
      await invoke({
        command: serving.options.command,
        workspace: serving.options.workspace,
        words: [...words, "--json"],
        started: holding(serving),
      }),
    );
  } catch (failure) {
    // The command refused what the request named. Whether that was the name's
    // fault or this machine's is not something a status code can tell apart, so
    // what the command said is the answer and the code is only its shape.
    answer(response, failure instanceof CommandFailed ? 400 : 500, {
      error: failure instanceof Error ? failure.message : String(failure),
    });
  }
}

/** Answers a read, or says that it is only ever a read. */
function get(request: IncomingMessage, response: ServerResponse, answering: () => void): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    answer(response, 405, { error: `that is read, not ${request.method ?? "asked for that way"}` });
    return;
  }

  answering();
}

function answer(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

/** Whether a request is addressed to this machine by one of its own names. */
function addressedHere(host: string | undefined): boolean {
  if (host === undefined) {
    return true;
  }

  // A bracketed IPv6 host keeps its brackets; everything else loses its port.
  const named = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");

  return loopbackNames.has(named.toLowerCase());
}

/**
 * What a request said, as the JSON it says it in -- or what is wrong with it.
 * Both requests that carry a body carry one of these, and a body that will not
 * parse is the same answer for either.
 */
async function jsonIn(
  request: IncomingMessage,
): Promise<{ readonly said: unknown } | { readonly error: string }> {
  try {
    const text = await bodyOf(request);

    return { said: text.trim() === "" ? {} : (JSON.parse(text) as unknown) };
  } catch (failure) {
    return { error: (failure as Error).message };
  }
}

/** What a request said, up to as much of it as this server will read. */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const part = chunk as Buffer;
    size += part.length;

    if (size > largestBody) {
      throw new Error("that request says more than a request to record could");
    }

    chunks.push(part);
  }

  return Buffer.concat(chunks).toString("utf8");
}
