/**
 * Serving a file out of one directory and never out of another.
 *
 * Both the Artifacts and the app itself are files under a directory this server
 * is willing to serve, and in both cases what a client asked for is a path it
 * built rather than one it was given. The guard is therefore the same guard, and
 * it lives here so that there is one of it: a second copy is a second thing to
 * get right the next time a directory is served.
 */
import type { ServerResponse } from "node:http";
import { resolve, sep } from "node:path";

/**
 * The file a request's path names, or nothing at all where it names anything
 * outside the directory. A segment is one path segment and never a path: a
 * client cannot climb out of the directory the tool serves, whatever it encoded.
 */
export function fileUnder(root: string, segments: readonly string[]): string | undefined {
  if (segments.length === 0) {
    return undefined;
  }

  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || /[\\/\0]/.test(segment)) {
      return undefined;
    }
  }

  const file = resolve(root, ...segments);

  return file.startsWith(resolve(root) + sep) ? file : undefined;
}

/** Says what went wrong about a file, in the words rather than as JSON. */
export function plainly(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${message}\n`);
}
