/**
 * The fixture site as a Project the tool has to start for itself: a command to
 * put in a `project.toml`, and a port nothing is listening on to point it at.
 *
 * A Project's configuration has to name where it will answer before it is
 * running, so an ephemeral port is no use here -- one is reserved and let go
 * of, and the command that claims it is spawned by the tool under test.
 */
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";

const entry = resolve(import.meta.dirname, "main.js");

export type FixtureSiteCommand = {
  readonly port: number;
  /** How long the site waits before it starts listening. */
  readonly delayMs?: number;
};

/** A shell command that serves the fixture site on the given port. */
export function fixtureSiteCommand({ port, delayMs = 0 }: FixtureSiteCommand): string {
  return `"${process.execPath}" "${entry}" ${port} ${delayMs}`;
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
