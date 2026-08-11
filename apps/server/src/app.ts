/**
 * Serving the app itself, so that opening the tool is opening this server
 * rather than finding a second one to start beside it.
 *
 * The app is files on disk and nothing more: the page it is opened at, the
 * stylesheet, and the browser modules `tsc` compiled beside them. Nothing here
 * knows what any of them contain -- the app asks this server for its answers
 * over the same API anything else would, which is why serving it costs the
 * server no knowledge of Projects, Runs or Artifacts.
 *
 * Only what the app is made of is served, by extension. The directory it lives
 * in is a package like any other, holding a manifest and TypeScript sources, and
 * none of those are the app.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join } from "node:path";

import { fileUnder, plainly } from "./files.js";

/** What the app is made of, and therefore all that is served out of it. */
const served: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/** The page the app is opened at, which is what the root of this server is. */
const opensAt = "index.html";

/**
 * Serves one file of the app, and the page itself for the path it is opened at.
 *
 * The app is not cached. It is rebuilt in place by `pnpm build` on the machine
 * running it, so a client holding yesterday's module would be reading a tool
 * that is no longer there.
 */
export async function serveApp(
  response: ServerResponse,
  directory: string,
  segments: readonly string[],
  method: string,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    return plainly(response, 405, `the app is fetched, not ${method}`);
  }

  const file = segments.length === 0 ? join(directory, opensAt) : fileUnder(directory, segments);

  if (file === undefined) {
    return plainly(response, 403, "that is not a path inside the app");
  }

  const type = served[extname(file).toLowerCase()];

  if (type === undefined) {
    return plainly(response, 404, "the app is not made of anything at that path");
  }

  const found = await stat(file).catch(() => undefined);

  if (found === undefined || !found.isFile()) {
    return plainly(response, 404, "the app is not made of anything at that path");
  }

  response.writeHead(200, {
    "content-type": type,
    "content-length": String(found.size),
    "cache-control": "no-store",
  });

  if (method === "HEAD") {
    return void response.end();
  }

  const reading = createReadStream(file);

  reading.on("error", () => {
    response.destroy();
  });
  response.on("close", () => {
    reading.destroy();
  });

  reading.pipe(response);
}
