/**
 * The Preview origin: one Project, proxied at the root of a loopback port of
 * its own, with the tool's driver injected into its pages.
 *
 * The app cannot script the Project's page -- the Project answers on its own
 * port and the app on this server's, so an iframe of it is cross-origin. This
 * is what closes that: the page comes back through an origin the app owns,
 * carrying a driver that listens for where to scroll to.
 *
 * It is mounted at the **root** because the site's own absolute URLs have to
 * keep resolving, and there is one **per Project** because which Project is
 * being previewed is then a fact about the origin rather than state this server
 * carries. Every method passes through: a site whose grid is fed by its own API
 * has to keep working while it is scrolled.
 *
 * This is the one thing this server holds that is not a `record` command
 * invoked and read back (ADR 0011). Even here the logic is thin: the driver it
 * injects is emitted by the command, so how a scroller is found is written once
 * and used by both capture and Preview.
 */
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

import { addressedHere, loopback } from "./loopback.js";

/**
 * Headers that describe one hop of a connection rather than the message, and
 * so must not be carried across to the next one.
 */
const perHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers of the Project's own that would stop a Preview being one at all: a
 * page refusing to be framed cannot be shown in the app, and a policy
 * forbidding inline script would drop the driver on the floor.
 *
 * Taken off here rather than asked of the Project, because a Project must not
 * have to be configured for the sake of being previewed. Nothing reaches this
 * origin but the app on this machine.
 */
const wouldRefuseTheFrame = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
]);

/** Where one Project is proxied, for as long as this server is serving. */
export type PreviewOrigin = {
  readonly project: string;
  /** Where it answers, with a trailing slash. The root of it is the Project's own root. */
  readonly url: string;
  /** What it proxies, which is the only thing it will proxy. */
  readonly baseUrl: string;
  close(): Promise<void>;
};

export type PreviewOrigins = {
  /**
   * The origin one Project is previewed through, allocated the first time a
   * Preview of it is asked for and kept afterwards -- a Parameter change must
   * not put a new origin on this machine any more than it puts a new frame in
   * the page.
   */
  serving(project: string, baseUrl: string, driver: string): Promise<PreviewOrigin>;
  closeAll(): Promise<void>;
};

/** The Preview origins this server has allocated, one per Project at most. */
export function previewOrigins(): PreviewOrigins {
  const allocated = new Map<string, Promise<Allocated>>();

  const opening = async (
    project: string,
    baseUrl: string,
    driver: string,
  ): Promise<Allocated> => {
    const standing = await allocated.get(project);

    // A Project reconfigured to answer somewhere else is a different Project to
    // proxy, so the origin pointed at the old one is no use to anybody.
    if (standing !== undefined && standing.baseUrl === baseUrl && standing.driver === driver) {
      return standing;
    }
    await standing?.close();

    return open(project, baseUrl, driver);
  };

  return {
    async serving(project, baseUrl, driver) {
      const allocating = opening(project, baseUrl, driver);
      allocated.set(project, allocating);

      try {
        return await allocating;
      } catch (failure) {
        allocated.delete(project);
        throw failure;
      }
    },

    async closeAll() {
      const standing = [...allocated.values()];
      allocated.clear();

      await Promise.all(
        standing.map((origin) => origin.then((one) => one.close()).catch(() => undefined)),
      );
    },
  };
}

/** One allocated origin, and what it was allocated for. */
type Allocated = PreviewOrigin & { readonly driver: string };

async function open(project: string, baseUrl: string, driver: string): Promise<Allocated> {
  const target = new URL(baseUrl);

  const server = createServer((request, response) => {
    void proxy(request, response, target, driver).catch(() => {
      if (!response.headersSent) {
        plainly(response, 502, "the Project did not answer that");
        return;
      }
      response.destroy();
    });
  });

  server.listen(0, loopback);
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the Preview origin did not bind a TCP port");
  }

  return {
    project,
    url: `http://${loopback}:${address.port}/`,
    baseUrl,
    driver,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** One request, forwarded to the Project and answered with what it said. */
async function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  driver: string,
): Promise<void> {
  if (!addressedHere(request.headers.host)) {
    return plainly(response, 403, "this origin answers loopback requests only");
  }

  const upstream = forwardedTo(request.url ?? "/", target);

  if (upstream === undefined) {
    // This is a Preview of one Project, not a proxy this tool has put on the
    // machine: anything outside what it was allocated for is refused.
    return plainly(response, 403, "this origin serves one Project, and that is not under it");
  }

  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;

  const forwarded = send(
    upstream,
    {
      method: request.method ?? "GET",
      headers: {
        ...withoutPerHop(request.headers),
        host: upstream.host,
        // Read as it was written, so a page can be injected into without being
        // decompressed first.
        "accept-encoding": "identity",
      },
    },
    (answered) => {
      void relay(answered, response, driver).catch(() => response.destroy());
    },
  );

  forwarded.on("error", () => {
    if (!response.headersSent) {
      plainly(response, 502, "the Project did not answer that");
      return;
    }
    response.destroy();
  });

  request.pipe(forwarded);
}

/**
 * What the Project answered, on its way back out -- an HTML page carrying the
 * driver, and everything else exactly as it came.
 */
async function relay(
  answered: IncomingMessage,
  response: ServerResponse,
  driver: string,
): Promise<void> {
  const headers = withoutPerHop(answered.headers);

  for (const name of wouldRefuseTheFrame) {
    delete headers[name];
  }

  const type = String(answered.headers["content-type"] ?? "");

  // Injection is into HTML responses only, and only where the Project answered
  // in bytes this can read. Everything else is passed through untouched.
  if (!type.includes("text/html") || answered.headers["content-encoding"] !== undefined) {
    response.writeHead(answered.statusCode ?? 200, headers);
    answered.pipe(response);
    return;
  }

  const page = injected(await bodyOf(answered), driver);

  delete headers["content-length"];
  response.writeHead(answered.statusCode ?? 200, {
    ...headers,
    "content-length": String(Buffer.byteLength(page)),
  });
  response.end(page);
}

/**
 * The page with the driver in it, at the end of the body: everything the page
 * declares has been parsed by then, which is what the scroller is found from.
 * A response that is not a document -- a fragment answered to the site's own
 * script, most of all -- gets it appended, where it is harmless.
 */
function injected(page: string, driver: string): string {
  const script = `<script data-record-preview>${driver}</script>`;
  const at = closingTag(page);

  return at === undefined ? page + script : page.slice(0, at) + script + page.slice(at);
}

/** Where the driver goes: before the body closes, or before the document does. */
function closingTag(page: string): number | undefined {
  for (const tag of ["</body", "</html"]) {
    const at = page.toLowerCase().lastIndexOf(tag);

    if (at !== -1) {
      return at;
    }
  }

  return undefined;
}

/**
 * Where a request to this origin goes, or nothing where it goes nowhere this
 * origin serves.
 *
 * Root-mounted onto the Project's own origin, so that a path the site
 * references absolutely resolves through here exactly as it does on the site.
 * A request naming another host -- written absolutely, or as a protocol-
 * relative path -- is what the origin check catches: this proxies one Project
 * and nothing else on this machine or off it.
 */
function forwardedTo(asked: string, target: URL): URL | undefined {
  if (!asked.startsWith("/")) {
    return undefined;
  }

  let upstream: URL;
  try {
    upstream = new URL(asked, target);
  } catch {
    return undefined;
  }

  return upstream.origin === target.origin ? upstream : undefined;
}

/** Whatever a message said, minus the headers that describe its own hop. */
function withoutPerHop(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string | string[]] =>
        entry[1] !== undefined && !perHop.has(entry[0].toLowerCase()),
    ),
  );
}

/** What the Project answered with, read whole so the driver can be put into it. */
async function bodyOf(answered: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of answered) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function plainly(response: ServerResponse, status: number, said: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${said}\n`);
}
