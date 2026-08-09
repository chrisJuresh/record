/**
 * Project lifecycle: having a Project answering before a Run records it, and
 * leaving the machine as the Run found it.
 *
 * A Project already answering its ready URL is used as it stands and left
 * running, because it is almost certainly the one the operator has open. Only a
 * Project this tool started is ever stopped -- there is no signal that would
 * distinguish a server started for a Run from the operator's own once both are
 * merely listening on a port, so the only safe rule is to stop what we started
 * and nothing else.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once as onceEvent } from "node:events";
import { get as httpGet, type RequestOptions } from "node:http";
import { get as httpsGet } from "node:https";
import { setTimeout as after } from "node:timers/promises";

import type { ProjectConfig } from "./config.js";
import { RecordError } from "./errors.js";

/** How long one health check waits for an answer before there is not one. */
const probeTimeoutMs = 2_000;

/** How long between health checks while a Project is coming up. */
const probeIntervalMs = 250;

/** How long a Project asked to stop is given before it is killed outright. */
const stopTimeoutMs = 5_000;

/** How much of what a Project printed is quoted when it would not come up. */
const quotedLines = 8;

export type RunningProject = {
  /** Where the Project was health-checked, which is where a failure names. */
  readonly readyUrl: string;
  /** True only when this tool started it, which is the only case it may be stopped in. */
  readonly started: boolean;
  /**
   * Stops the Project if this tool started it, and never otherwise. Answers
   * whether it stopped one, and is safe to call more than once.
   */
  stop(): Promise<boolean>;
};

/** Where a Project says it answers when it is ready to record. */
export function readyUrl(project: ProjectConfig): string {
  try {
    return new URL(project.readyPath, project.baseUrl).href;
  } catch {
    throw new RecordError(
      `Project '${project.name}' cannot be reached: base_url '${project.baseUrl}' and ` +
        `ready_path '${project.readyPath}' do not make a URL`,
    );
  }
}

/**
 * A Project answering at its ready URL, started from its configured command if
 * it was not answering already.
 */
export async function ensureRunning(project: ProjectConfig): Promise<RunningProject> {
  const url = readyUrl(project);

  if (await answers(url)) {
    return { readyUrl: url, started: false, stop: async () => false };
  }

  const command = project.startCommand;
  if (command === undefined) {
    throw new RecordError(
      `Project '${project.name}' is not answering at ${url}, ` +
        "and declares no start_command to start it with",
    );
  }

  const running = start(project, command);

  try {
    await waitUntilReady(project, url, running);
  } catch (failure) {
    await halt(running.process);
    throw failure;
  }

  let stopped = false;

  return {
    readyUrl: url,
    started: true,
    async stop() {
      if (stopped) {
        return false;
      }
      stopped = true;
      await halt(running.process);
      return true;
    },
  };
}

/** A Project this tool started, and what it has had to say for itself. */
type Started = {
  readonly process: ChildProcess;
  /** The tail of what it printed, which is what explains one that will not come up. */
  said(): string;
  /** Why it will never answer, if it has already failed outright. */
  died(): string | undefined;
};

function start(project: ProjectConfig, command: string): Started {
  const child = spawn(command, {
    ...(project.workingDirectory === undefined ? {} : { cwd: project.workingDirectory }),
    // A start command is a command line as its author would type it, so it is
    // read by a shell rather than split here.
    shell: true,
    // What the Project prints is not this Run's output, but the end of it is
    // the only account there is of a Project that would not come up.
    stdio: ["ignore", "pipe", "pipe"],
    // A shell's own child is what actually serves, so on POSIX the pair is put
    // in a process group that can be signalled as one. Windows has no groups;
    // stopping walks the process tree instead.
    detached: process.platform !== "win32",
  });

  let said = "";
  let died: string | undefined;

  const read = (chunk: Buffer | string) => {
    said = lastLines(said + String(chunk));
  };

  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  child.on("error", (failure) => {
    died = failure.message;
  });
  child.on("exit", (code, signal) => {
    died ??= signal === null ? `it exited with ${code}` : `it was stopped by ${signal}`;
  });

  return { process: child, said: () => said, died: () => died };
}

/**
 * Waits for the ready URL to answer, and gives up when the Project's own
 * deadline passes. A Project that dies on the way up is not waited out: the
 * failure it already is says more than the deadline would.
 */
async function waitUntilReady(project: ProjectConfig, url: string, running: Started): Promise<void> {
  const deadline = Date.now() + project.readyTimeoutMs;

  do {
    const died = running.died();
    if (died !== undefined) {
      throw new RecordError(
        `Project '${project.name}' was started with '${project.startCommand}', but ` +
          `${died} before ${url} answered${quoting(running.said())}`,
      );
    }

    if (await answers(url)) {
      return;
    }

    await after(probeIntervalMs);
  } while (Date.now() < deadline);

  throw new RecordError(
    `Project '${project.name}' was started with '${project.startCommand}', but ` +
      `${url} did not answer within ${project.readyTimeoutMs}ms${quoting(running.said())}`,
  );
}

/**
 * Whether anything is serving the ready URL. Any answer short of an error
 * status counts: a Project that is up but replies 404 there is one whose
 * ready_path names a page it does not serve, and starting a second copy of it
 * would not help.
 */
async function answers(url: string): Promise<boolean> {
  const request = new URL(url).protocol === "https:" ? httpsGet : httpGet;
  const options: RequestOptions = { agent: false, timeout: probeTimeoutMs };

  return new Promise<boolean>((resolve) => {
    const attempt = request(url, options, (response) => {
      // Drained rather than read: what the ready URL says is no business of
      // this tool's, but a body left unread would hold the socket open.
      response.resume();
      resolve((response.statusCode ?? 0) < 400);
    });

    attempt.on("timeout", () => {
      attempt.destroy();
      resolve(false);
    });
    attempt.on("error", () => resolve(false));
  });
}

/** Stops a Project this tool started, politely first and then not. */
async function halt(child: ChildProcess): Promise<void> {
  if (!alive(child)) {
    return;
  }

  const exited = onceEvent(child, "exit").catch(() => undefined);

  signal(child, "SIGTERM");
  await Promise.race([exited, after(stopTimeoutMs)]);

  if (alive(child)) {
    signal(child, "SIGKILL");
    await Promise.race([exited, after(stopTimeoutMs)]);
  }
}

function alive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/**
 * Signals the whole of what was started, not only the shell that fronts it: a
 * server left running under a dead shell would hold the port a later Run needs.
 */
function signal(child: ChildProcess, sending: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    // Windows has no process group to signal, and no polite kill either.
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    killer.on("error", () => child.kill(sending));
    return;
  }

  try {
    process.kill(-pid, sending);
  } catch {
    child.kill(sending);
  }
}

/** What the Project printed, if it printed anything worth showing. */
function quoting(said: string): string {
  const trimmed = said.trim();
  return trimmed === "" ? "" : `:\n${trimmed}`;
}

function lastLines(output: string): string {
  return output.split(/\r?\n/).slice(-quotedLines).join("\n");
}
