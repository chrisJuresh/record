/**
 * Write out/mockups.html with a real still baked into it.
 *
 * mockups.html ships with a synthetic placeholder because this repository is
 * public and the photos Project renders a real photo library -- see ADR 0007.
 * This script takes one Frame out of a Run's MP4, inlines it as a data URI, and
 * writes the result under out/, which is not committed. The output is still a
 * single self-contained file with no external requests; the only difference is
 * what the <img> is showing.
 *
 *   node inline-still.mjs                                  # newest Run of photos/scroll-peek
 *   node inline-still.mjs ../../runs/notes/type-and-save   # newest Run under a directory
 *   node inline-still.mjs some-frame.png                   # an image, taken as-is
 *   node inline-still.mjs --at 1.4                         # a different instant of the clip
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
const ffprobe = () => process.env["RECORD_FFPROBE"] || "ffprobe";

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
let source = DEFAULT_SOURCE;
let at = null;

for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--at") {
    at = Number(argv[index + 1]);
    if (!Number.isFinite(at) || at < 0) fail(`--at wants a number of seconds, not "${argv[index + 1]}"`);
    index += 1;
  } else {
    source = resolve(process.cwd(), argv[index]);
  }
}

// ------------------------------------------------------------------- helpers

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(executable, args) {
  return new Promise((settle, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (failure) =>
      reject(new Error(`could not run ${executable}: ${failure.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) settle(Buffer.concat(stdout));
      else reject(new Error(`${executable} exited ${code}\n${Buffer.concat(stderr)}`));
    });
  });
}

/** Every file under a directory, newest first. A plain file is returned as itself. */
async function candidates(path) {
  const details = await stat(path).catch(() => null);
  if (!details) fail(`nothing at ${path}`);
  if (details.isFile()) return [{ path, modified: details.mtimeMs }];

  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    found.push({ path: full, modified: (await stat(full)).mtimeMs });
  }
  return found.sort((a, b) => b.modified - a.modified);
}

// ---------------------------------------------------------------------- still

async function chooseStill() {
  const found = await candidates(source);
  const still = found.find((file) => {
    const extension = extname(file.path).toLowerCase();
    return VIDEO.has(extension) || IMAGE.has(extension);
  });

  if (!still) {
    fail(
      `no video or image under ${source}.\n` +
        `Record something first — pnpm record run photos scroll-peek — or name a file.`
    );
  }
  return still.path;
}

async function durationOf(video) {
  const probed = await run(ffprobe(), [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    video,
  ]);
  const seconds = Number(String(probed).trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * One Frame as a JPEG. JPEG rather than PNG because a photographic still lands
 * in the sheet as a base64 data URI, and a PNG of a photo grid is megabytes of
 * it.
 */
async function frameOf(video) {
  const instant = at ?? (await durationOf(video)) / 2;
  return run(ffmpeg(), [
    "-v", "error",
    "-ss", String(instant),
    "-i", video,
    "-frames:v", "1",
    "-q:v", "3",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-",
  ]).then((bytes) => ({ bytes, mime: "image/jpeg", instant }));
}

async function imageOf(file) {
  const extension = extname(file).toLowerCase();
  return {
    bytes: await readFile(file),
    mime: extension === ".png" ? "image/png" : "image/jpeg",
    instant: null,
  };
}

// -------------------------------------------------------------------- rewrite

/** Replace the one expression between a pair of markers with a string literal. */
function replaceBetween(html, marker, literal) {
  const pattern = new RegExp(`(/\\* ${marker}:BEGIN \\*/)[\\s\\S]*?(/\\* ${marker}:END \\*/)`);
  if (!pattern.test(html)) fail(`mockups.html has no ${marker} markers — has it been edited?`);
  return html.replace(pattern, `$1 ${JSON.stringify(literal)} $2`);
}

const stillFile = await chooseStill();
const still = VIDEO.has(extname(stillFile).toLowerCase())
  ? await frameOf(stillFile)
  : await imageOf(stillFile);

const dataUri = `data:${still.mime};base64,${still.bytes.toString("base64")}`;
const provenance =
  `a real still from ${basename(stillFile)}` +
  (still.instant === null ? "" : ` at ${still.instant.toFixed(2)}s`);

let html = await readFile(SHEET, "utf8");
html = replaceBetween(html, "STILL", dataUri);
html = replaceBetween(html, "PROVENANCE", provenance);

await mkdir(join(HERE, "out"), { recursive: true });
await writeFile(OUT, html);

const megabytes = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`still:  ${relative(process.cwd(), stillFile)}${still.instant === null ? "" : ` at ${still.instant.toFixed(2)}s`}`);
console.log(`wrote:  ${relative(process.cwd(), OUT)} (${megabytes} MB, self-contained)`);
console.log(`note:   out/ is not committed — that still is a real capture.`);
