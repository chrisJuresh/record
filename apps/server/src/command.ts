/**
 * Invoking the `record` command, which is the only way this server knows
 * anything at all.
 *
 * Nothing here reads a Project, evaluates a Timeline or encodes an Artifact:
 * the command answers and this reads the answer back. That is what keeps one
 * implementation behind the UI, the command line and any agent session, and it
 * is why a failure is passed on in the command's own words rather than
 * rephrased into something generic.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * The command as this server runs it: nothing to say to it, and both of its
 * outputs read -- its answer on one and what it is doing on the other.
 */
export type RecordChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * How `record` is run: the executable, and the words that come before a
 * command's own. Handed in rather than found on this machine, so the server
 * invokes exactly the command that started it.
 */
export type RecordCommand = {
  readonly executable: string;
  readonly entry: readonly string[];
};

/**
 * The prefix `record run --progress` writes each progress under, which is how a
 * line saying what a Run is doing is told from a warning or a failure. The
 * command's other lines are prefixed the same way.
 */
const progressPrefix = "progress: ";

/**
 * ...and the prefix its warnings are written under. A warning is not what
 * stopped a Run, so it is kept out of the failure -- and nothing is lost by
 * that, because everything the command warns about is in the answer it writes
 * on stdout as well.
 */
const warningPrefix = "warning: ";

/** What the command said when it failed, so that is what a client is shown. */
export class CommandFailed extends Error {
  /** What the command exited with. */
  readonly code: number;
  /**
   * Whatever it managed to answer with before failing. A request recording many
   * Actions fails when one of them does and still reports every Run that
   * recorded, so its answer is worth keeping.
   */
  readonly answered: unknown;

  constructor(message: string, code: number, answered: unknown) {
    super(message);
    this.name = "CommandFailed";
    this.code = code;
    this.answered = answered;
  }
}

export type Invocation = {
  readonly command: RecordCommand;
  /** The workspace the command reads its Projects from. */
  readonly workspace: string;
  /** The command's own words, `--json` included. */
  readonly words: readonly string[];
  /** Told what a Run is doing, where the words asked the command for progress. */
  readonly progress?: (event: unknown) => void;
  /** Told the child, so a server being closed can stop what it started. */
  readonly started?: (child: RecordChild) => void;
};

/**
 * Runs the command and answers with whatever its `--json` output said, or
 * throws what it said on the way out.
 */
export async function invoke(asked: Invocation): Promise<unknown> {
  const child = spawn(asked.command.executable, [...asked.command.entry, ...asked.words], {
    env: { ...process.env, RECORD_WORKSPACE: asked.workspace },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  asked.started?.(child);

  let answer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    answer += chunk;
  });

  // Progress, warnings and failures share stderr, so the prefixes are what
  // separate them -- and what is left over is what the failure will be said in.
  const said: string[] = [];
  eachLine(child.stderr, (line) => {
    if (line.startsWith(progressPrefix)) {
      const event = asJson(line.slice(progressPrefix.length));

      if (event !== undefined) {
        asked.progress?.(event.value);
        return;
      }
    }

    if (!line.startsWith(warningPrefix)) {
      said.push(line);
    }
  });

  const code = await ended(child);
  const answered = asJson(answer);

  if (code !== 0) {
    throw new CommandFailed(
      said.join("\n").trim() || `record exited with ${code}`,
      code,
      answered?.value,
    );
  }

  if (answered === undefined) {
    throw new CommandFailed("record answered with nothing a client could read", code, undefined);
  }

  return answered.value;
}

/**
 * What the command exited with, once its output is drained -- or the failure
 * that stopped it being run at all, which no exit code could have said.
 */
async function ended(child: RecordChild): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      resolve(code ?? 1);
    });
  });
}

/** One line at a time, however the writes happened to be split into chunks. */
function eachLine(stream: Readable, line: (text: string) => void): void {
  let rest = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? "";

    for (const one of lines) {
      line(one);
    }
  });
  stream.on("end", () => {
    if (rest !== "") {
      line(rest);
    }
  });
}

/**
 * What some text said, where it said anything a client could read. Wrapped
 * rather than answered bare, because a command answering `null` said something
 * and a command answering nothing did not.
 */
function asJson(text: string): { readonly value: unknown } | undefined {
  if (text.trim() === "") {
    return undefined;
  }

  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}
