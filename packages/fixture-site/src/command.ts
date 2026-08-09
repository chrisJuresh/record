/**
 * The fixture site as a Project the tool has to start for itself: a command to
 * put in a `project.toml`, the directory to run it from, and a port nothing is
 * listening on to point it at.
 *
 * A Project's configuration has to name where it will answer before it is
 * running, so an ephemeral port is no use here -- one is reserved and let go
 * of, and the command that claims it is spawned by the tool under test.
 */
import { once } from "node:events";
import { createServer } from "node:net";

/**
 * The directory the command below has to be run from. It names its script
 * relatively on purpose, so that a Project's `working_directory` being ignored
 * is a Project that does not start rather than one that quietly still works.
 */
export const fixtureSiteDirectory = import.meta.dirname;

export type FixtureSiteOptions = {
  readonly port: number;
  /** How long the site waits before it starts listening. */
  readonly delayMs?: number;
};

/** A shell command that serves the fixture site, run from `fixtureSiteDirectory`. */
export function fixtureSiteCommand({ port, delayMs = 0 }: FixtureSiteOptions): string {
  return `"${process.execPath}" main.js ${port} ${delayMs}`;
}

/**
 * A port nothing is listening on. Reserving it and letting it go is the only
 * way to name one in advance; the window between is small enough that no test
 * on this machine has ever lost it.
 */
export async function freePort(): Promise<number> {
  const server = createServer();

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no TCP port was bound to reserve");
  }

  server.close();
  await once(server, "close");

  return address.port;
}
