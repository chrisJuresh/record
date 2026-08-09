/**
 * Write out/mockups.html with a real Frame baked into it.
 *
 * mockups.html ships with a synthetic placeholder because this repository is
 * public and the photos Project renders a real photo library -- see ADR 0007.
 * This script takes one Frame out of a Run's MP4, inlines it as a data URI, and
 * writes the result under out/, which is not committed. The output is still a
 * single self-contained file with no external requests; the only difference is
 * what the <img> is showing.
 *
 *   node inline-frame.mjs                                  # newest Run of photos/scroll-peek
 *   node inline-frame.mjs ../../runs/notes/type-and-save   # newest Run under a directory
 *   node inline-frame.mjs some-frame.png                   # an image, taken as-is
 *   node inline-frame.mjs --at 1.4                         # a different instant of the clip
 *
 * Throwaway, like the sheets it feeds. Delete all three once a Mockup is chosen.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const HERE = import.meta.dirname;
const SHEET = join(HERE, "mockups.html");
const OUT = join(HERE, "out", "mockups.html");
const DEFAULT_SOURCE = resolve(HERE, "../../runs/photos/scroll-peek");

const VIDEO = new Set([".mp4", ".webm"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg"]);

const ffmpeg = () => process.env["RECORD_FFMPEG"] || "ffmpeg";

/**
 * A failure the person running this can fix, reported as a message. Anything
 * else keeps its stack, the way `RecordError` divides them in the engine.
 */
class Fixable extends Error {}

const refuse = (message) => {
  throw new Fixable(message);
};

// ------------------------------------------------------------------ arguments

function readArguments(argv) {
  let source = DEFAULT_SOURCE;
  let at = null;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--at") {
      at = Number(argv[index + 1]);
      if (!Number.isFinite(at) || at < 0) {
        refuse(`--at wants a number of seconds, not "${argv[index + 1]}"`);
      }
      index += 1;
    } else {
      source = resolve(process.cwd(), argv[index]);
    }
  }
  return { source, at };
}

// ------------------------------------------------------------------- external

function run(executable, args) {
  return new Promise((settle, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (failure) =>
      reject(
        new Fixable(
          `could not run ${executable}: ${failure.message}. ` +
            `Install ffmpeg, or name a copy in $RECORD_FFMPEG`
        )
      )
    );
    child.on("close", (code) => {
      if (code === 0) settle(Buffer.concat(stdout));
      else reject(new Fixable(`${executable} exited ${code}\n${Buffer.concat(stderr)}`));
    });
  });
}

// ---------------------------------------------------------------------- Frame

/**
 * Every file under a directory, newest first; a plain file is returned as
 * itself. The newest file rather than the Run history, because a spike that
 * needed the workspace built to find one MP4 would be a spike nobody runs.
 */
async function candidates(path) {
  const details = await stat(path).catch(() => null);
  if (!details) refuse(`nothing at ${path}`);
  if (details.isFile()) return [{ path, modified: details.mtimeMs }];

  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    found.push({ path: full, modified: (await stat(full)).mtimeMs });
  }
  return found.sort((a, b) => b.modified - a.modified);
}

async function chooseSource(source) {
  const found = await candidates(source);
  const newest = found.find((file) => {
    const extension = extname(file.path).toLowerCase();
    return VIDEO.has(extension) || IMAGE.has(extension);
  });

  if (!newest) {
    refuse(
      `no video or image under ${source}.\n` +
        `Record something first -- pnpm record run photos scroll-peek -- or name a file.`
    );
  }
  return newest.path;
}

async function durationOf(video) {
  const probed = String(await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    video,
  ])).trim();

  const seconds = Number(probed);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    refuse(`ffprobe could not say how long ${basename(video)} is (it said "${probed}")`);
  }
  return seconds;
}

/**
 * One Frame as a JPEG. JPEG rather than PNG because a photographic Frame lands
 * in the sheet as a base64 data URI, and a PNG of a photo grid is megabytes of
 * it.
 */
async function frameOf(video, at) {
  const duration = await durationOf(video);
  const instant = at ?? duration / 2;

  // Asked up front, because ffmpeg's own complaint about seeking past the end
  // of a clip is a page of encoder internals with the actual problem nowhere
  // in it.
  if (instant >= duration) {
    refuse(
      `${basename(video)} is only ${duration.toFixed(2)}s long, ` +
        `so there is no Frame at ${instant.toFixed(2)}s. Try a smaller --at`
    );
  }

  const bytes = await run(ffmpeg(), [
    "-v", "error",
    "-ss", String(instant),
    "-i", video,
    "-frames:v", "1",
    "-q:v", "3",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-",
  ]);

  // ffmpeg is happy to seek past the end of a clip and encode nothing at all.
  if (bytes.length === 0) {
    refuse(
      `no Frame at ${instant.toFixed(2)}s of ${basename(video)} -- ` +
        `the clip is shorter than that. Try a smaller --at`
    );
  }
  return { bytes, mime: "image/jpeg", instant };
}

async function imageOf(file) {
  const bytes = await readFile(file);
  if (bytes.length === 0) refuse(`${basename(file)} is empty`);
  return { bytes, mime: extname(file).toLowerCase() === ".png" ? "image/png" : "image/jpeg", instant: null };
}

// -------------------------------------------------------------------- rewrite

/** Replace the one expression between a pair of markers with a string literal. */
function replaceBetween(html, marker, literal) {
  const pattern = new RegExp(`(/\\* ${marker}:BEGIN \\*/)[\\s\\S]*?(/\\* ${marker}:END \\*/)`);
  if (!pattern.test(html)) refuse(`mockups.html has no ${marker} markers -- has it been edited?`);
  return html.replace(pattern, `$1 ${JSON.stringify(literal)} $2`);
}

// ----------------------------------------------------------------------- main

async function main() {
  const { source, at } = readArguments(process.argv.slice(2));
  const file = await chooseSource(source);
  const frame = VIDEO.has(extname(file).toLowerCase())
    ? await frameOf(file, at)
    : await imageOf(file);

  const instant = frame.instant === null ? "" : ` at ${frame.instant.toFixed(2)}s`;
  const dataUri = `data:${frame.mime};base64,${frame.bytes.toString("base64")}`;

  let html = await readFile(SHEET, "utf8");
  html = replaceBetween(html, "FRAME", dataUri);
  html = replaceBetween(html, "PROVENANCE", `a real Frame of ${basename(file)}${instant}`);

  await mkdir(join(HERE, "out"), { recursive: true });
  await writeFile(OUT, html);

  const megabytes = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
  console.log(`Frame:  ${relative(process.cwd(), file)}${instant}`);
  console.log(`wrote:  ${relative(process.cwd(), OUT)} (${megabytes} MB, self-contained)`);
  console.log(`note:   out/ is not committed -- that Frame came from a real Run.`);
}

try {
  await main();
} catch (failure) {
  if (!(failure instanceof Fixable)) throw failure;
  console.error(failure.message);
  process.exit(1);
}
