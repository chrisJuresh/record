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

  const [first, second, third, fourth, fifth, sixth] = segments;

  if (segments.length === 0) {
    return get(request, response, () => answer(response, 200, index(serving)));
  }

  if (first === "artifacts") {
    if (method !== "GET" && method !== "HEAD") {
      return answer(response, 405, { error: `an Artifact is fetched, not ${method}` });
    }

    return serveArtifact(response, serving.options.workspace, segments.slice(1), {
      range: request.headers.range,
      method,
    });
  }

  if (first !== "api") {
    return answer(response, 404, { error: "nothing is served at that path" });
  }

  // Everything below is the command, invoked and read back. Which command each
  // path names is the whole of the mapping: nothing here decides an answer.
  if (second === "projects" && segments.length === 2) {
    return get(request, response, () => command(response, serving, ["projects"]));
  }

  if (second === "projects" && fourth === "actions" && segments.length === 4) {
    return get(request, response, () => command(response, serving, ["actions", third ?? ""]));
  }

  if (second === "projects" && sixth === "parameters" && segments.length === 6) {
    return get(request, response, () =>
      command(response, serving, ["parameters", third ?? "", fifth ?? ""]),
    );
  }

  if (second === "mockups" && segments.length === 2) {
    return get(request, response, () => command(response, serving, ["mockups"]));
  }

  if (second === "status" && segments.length === 2) {
    const project = url.searchParams.get("project");

    return get(request, response, () =>
      command(response, serving, ["status", ...(project === null ? [] : [project])]),
    );
  }

  if (second === "history" && (segments.length === 4 || segments.length === 5)) {
    return get(request, response, () =>
      command(response, serving, [
        "history",
        third ?? "",
        fourth ?? "",
        ...(fifth === undefined ? [] : [fifth]),
      ]),
    );
  }

  if (second === "runs" && segments.length === 2) {
    if (method === "POST") {
      return record(request, response, serving);
    }

    return get(request, response, () => answer(response, 200, serving.runs.all()));
  }

  if (second === "runs" && segments.length === 3) {
    const asked = serving.runs.read(third ?? "");

    return get(request, response, () =>
      asked === undefined
        ? answer(response, 404, { error: "no Run was asked for under that name" })
        : answer(response, 200, asked),
    );
  }

  if (second === "runs" && fourth === "events" && segments.length === 4) {
    return get(request, response, () => stream(request, response, serving, third ?? ""));
  }

  return answer(response, 404, { error: "nothing is served at that path" });
}

/** What this server offers, for whoever opened it in a browser to read. */
function index(serving: Serving): unknown {
  return {
    record: "serving this machine only",
    workspace: serving.options.workspace,
    endpoints: [
      "GET  /api/projects",
      "GET  /api/projects/<project>/actions",
      "GET  /api/projects/<project>/actions/<action>/parameters",
      "GET  /api/mockups",
      "GET  /api/status[?project=<project>]",
      "GET  /api/history/<project>/<action>[/<condition>]",
      "GET  /api/runs",
      "POST /api/runs",
      "GET  /api/runs/<id>",
      "GET  /api/runs/<id>/events",
      "GET  /artifacts/<project>/<action>/<run>/<file>",
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
  let body: unknown;

  try {
    const text = await bodyOf(request);
    body = text.trim() === "" ? {} : JSON.parse(text);
  } catch (failure) {
    return answer(response, 400, { error: (failure as Error).message });
  }

  const asked = wordsFor(body);

  if ("error" in asked) {
    return answer(response, 400, { error: asked.error });
  }

  const begun = serving.runs.begin(asked.words);

  // Not awaited: the answer goes back now and the recording goes on without it.
  void invoke({
    command: serving.options.command,
    workspace: serving.options.workspace,
    words: asked.words,
    progress: (event) => {
      serving.runs.progress(begun.id, event);
    },
    started: (child) => {
      serving.children.add(child);
      child.once("close", () => serving.children.delete(child));
    },
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
    if (!Array.isArray(sets) || sets.some((entry) => typeof entry !== "string" || !entry.includes("="))) {
      return { error: "'set' is a list of name=value Overrides" };
    }
    for (const assignment of sets as string[]) {
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
        started: (child) => {
          serving.children.add(child);
          child.once("close", () => serving.children.delete(child));
        },
      }),
    );
  } catch (failure) {
    // The command refused what the request named, so the request is what was
    // wrong -- and what it said is more use than any status code.
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
