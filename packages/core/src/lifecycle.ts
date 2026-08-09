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
   * Stops the Project if this tool started it, and never otherwise. Safe to
   * call on one that has already stopped, or that was never started.
   */
  stop(): Promise<void>;
};

/** Where a Project says it answers when it is ready to record. */
function readyUrl(project: ProjectConfig): string {
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
    return { readyUrl: url, started: false, stop: async () => undefined };
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

  return {
    readyUrl: url,
    started: true,
    stop: () => halt(running.process),
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
 * Whether the Project is serving its ready URL. An error status is not an
 * answer -- a site still building can say 503 at the path it will serve when it
 * is done, and waiting is exactly what that case wants. The cost is that a
 * ready_path naming something the Project never serves reads as a Project that
 * is not running, and the start command that follows fails on the taken port.
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

/**
 * Stops a Project this tool started -- all of it, not only the shell that
 * fronts it, because a server left running under a dead shell would hold the
 * port the next Run needs.
 */
async function halt(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !alive(child)) {
    return;
  }

  const exited = onceEvent(child, "exit").catch(() => undefined);

  if (process.platform === "win32") {
    // Windows offers no process group to signal and no polite kill of a tree:
    // taskkill walking it is the whole of what can be done.
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    killer.on("error", () => child.kill());

    await Promise.race([exited, after(stopTimeoutMs)]);
    return;
  }

  // The process group rather than the shell, and asked before it is told.
  signalGroup(child, pid, "SIGTERM");
  await Promise.race([exited, after(stopTimeoutMs)]);

  if (alive(child)) {
    signalGroup(child, pid, "SIGKILL");
    await Promise.race([exited, after(stopTimeoutMs)]);
  }
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Signals the group the Project was started in, or the Project alone if it has none. */
function signalGroup(child: ChildProcess, pid: number, sending: "SIGTERM" | "SIGKILL"): void {
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
