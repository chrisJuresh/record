/**
 * Serving what a Run left behind, so that a clip is watched where it will be
 * embedded rather than opened out of a folder.
 *
 * Byte ranges are answered because that is what playing a video in a browser
 * comes to: without them a clip cannot be sought and some browsers will not
 * play it at all. Nothing here reads a Run's record or decides which Run is
 * Latest -- it serves the files under the workspace's `runs`, and which of them
 * is worth playing is the command's answer to say.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

/** What each Artifact is, said so a browser plays it rather than downloads it. */
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
};

/** One range of a file a client asked for, or the whole of it. */
type Span = { readonly from: number; readonly to: number };

/**
 * Serves one file from beneath the workspace's Runs, answering 404 for anything
 * that is not there and 403 for a path reaching outside them.
 */
export async function serveArtifact(
  response: ServerResponse,
  workspace: string,
  segments: readonly string[],
  request: { readonly range: string | undefined; readonly method: string },
): Promise<void> {
  const runs = join(workspace, "runs");
  const file = fileUnder(runs, segments);

  if (file === undefined) {
    return plainly(response, 403, "that is not a path inside this workspace's Runs");
  }

  const found = await stat(file).catch(() => undefined);

  if (found === undefined || !found.isFile()) {
    return plainly(response, 404, "no Artifact is kept at that path");
  }

  const span = spanOf(request.range, found.size);

  if (span === "unsatisfiable") {
    response.writeHead(416, {
      "content-range": `bytes */${found.size}`,
      "accept-ranges": "bytes",
    });
    return void response.end();
  }

  const headers = {
    "content-type": contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(span === undefined ? found.size : span.to - span.from + 1),
    "accept-ranges": "bytes",
    // A Run writes into a directory of its own and never over another's, but
    // what a client asked for may well be a path it built from a Run that has
    // since been pruned. Nothing here is worth a stale hit.
    "cache-control": "no-store",
    ...(span === undefined
      ? {}
      : { "content-range": `bytes ${span.from}-${span.to}/${found.size}` }),
  };

  response.writeHead(span === undefined ? 200 : 206, headers);

  // A HEAD says how the file would be served without serving it, which is what
  // a video element asks before it decides how to fetch the rest.
  if (request.method === "HEAD") {
    return void response.end();
  }

  const reading = createReadStream(
    file,
    span === undefined ? {} : { start: span.from, end: span.to },
  );

  reading.on("error", () => {
    response.destroy();
  });
  response.on("close", () => {
    reading.destroy();
  });

  reading.pipe(response);
}

/**
 * The file a request's path names, or nothing at all where it names anything
 * outside the Runs. A segment is one path segment and never a path: a client
 * cannot climb out of the directory the tool serves, whatever it encoded.
 */
function fileUnder(runs: string, segments: readonly string[]): string | undefined {
  if (segments.length === 0) {
    return undefined;
  }

  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || /[\\/\0]/.test(segment)) {
      return undefined;
    }
  }

  const file = resolve(runs, ...segments);

  return file.startsWith(resolve(runs) + sep) ? file : undefined;
}

/**
 * The bytes a client asked for, or nothing where it asked for the whole file.
 * One range only: several would be a multipart answer, which nothing playing a
 * clip has ever asked for.
 */
function spanOf(header: string | undefined, size: number): Span | "unsatisfiable" | undefined {
  const asked = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");

  if (asked === null) {
    return undefined;
  }

  const [, first = "", last = ""] = asked;

  if (first === "" && last === "") {
    return undefined;
  }

  // 'bytes=-500' is the last 500 bytes, which is how a container's index is
  // read before anything is decoded.
  const from = first === "" ? Math.max(0, size - Number(last)) : Number(first);
  const to = first === "" || last === "" ? size - 1 : Math.min(Number(last), size - 1);

  return from > to || from >= size ? "unsatisfiable" : { from, to };
}

function plainly(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${message}\n`);
}
