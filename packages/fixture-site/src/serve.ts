/**
 * Serves the committed fixture site on an ephemeral port, so that a test never
 * needs a real Project running and two tests never contend for a port.
 */
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const siteRoot = resolve(import.meta.dirname, "../../site");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

export type FixtureSite = {
  /** Base URL of the running site, with a trailing slash. */
  readonly url: string;
  close(): Promise<void>;
};

/**
 * Serves the fixture site, on an ephemeral port unless one is named. A port is
 * named only by a Project the tool has to start itself, whose `project.toml`
 * has to say where it will answer before it is running.
 */
export async function startFixtureSite(port = 0, delayMs = 0): Promise<FixtureSite> {
  const server = createServer((request, response) => {
    void handle(request, response);
  });

  // A Project that takes a moment to come up is the case worth exercising: the
  // tool has to wait for the ready URL rather than assume the command's return.
  await delay(delayMs);

  server.listen(port, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture site did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const file = resolveFile(request.url ?? "/");
  if (file === undefined) {
    return respond(response, 404, "text/plain; charset=utf-8", "not found");
  }

  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return respond(response, 404, "text/plain; charset=utf-8", "not found");
  }

  respond(response, 200, contentTypes[extname(file)] ?? "application/octet-stream", body);
}

/** The file a request URL names, or undefined if it names anything outside the site. */
function resolveFile(requestUrl: string): string | undefined {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  } catch {
    return undefined;
  }

  const requested = resolve(siteRoot, `.${pathname}`);
  const file = pathname.endsWith("/") ? join(requested, "index.html") : requested;

  return file === siteRoot || file.startsWith(siteRoot + sep) ? file : undefined;
}

function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer | string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
  });
  response.end(body);
}
