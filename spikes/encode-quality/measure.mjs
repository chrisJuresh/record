/**
 * What each video encoder's CRF number actually buys, on one clip's Frames.
 *
 * Throwaway evidence behind the MP4's quality target. It encodes a directory of
 * captured Frames through the same filter chain `encode.ts` builds, once per CRF
 * per encoder, and scores every result against a lossless reference made from
 * those same Frames. So the two columns are bytes and quality, which is the only
 * pair that lets 22 of x264 be held against 32 of VP9 -- the numbers themselves
 * are on scales that have nothing to say to each other.
 *
 *   node measure.mjs <frames>            1280x800, the tool's own video_width
 *   node measure.mjs <frames> 1440 900   the size the clip was captured at
 *
 * <frames> is a directory of `f0000.png` upwards. A Run deletes its Frames as
 * soon as they are encoded, so getting one means stopping it from doing that:
 * comment out the `rm(frames, ...)` in `run.ts` and record once.
 *
 * Needs an ffmpeg built with libvmaf, which the one in TOOLING.md is.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const frames = resolve(process.argv[2] ?? ".");
const width = Number(process.argv[3] ?? 1280);
const height = Number(process.argv[4] ?? 800);
const framerate = 60;

/** The CRFs to try, per encoder. The shipping value is in each list. */
const sweep = {
  mp4: [18, 20, 21, 22, 23, 24, 25, 26, 28],
  webm: [28, 30, 32, 34, 36],
};

const ffmpeg = process.env["RECORD_FFMPEG"] || "ffmpeg";
const out = join(import.meta.dirname, "out");
await mkdir(out, { recursive: true });

const count = (await readdir(frames)).filter((name) => /^f\d+\.png$/.test(name)).length;
if (count === 0) {
  console.error(`no Frames in ${frames}: expected f0000.png upwards`);
  process.exit(1);
}

/** What every encode reads, and the filters `encode.ts` puts between it and the encoder. */
const input = [
  "-framerate",
  String(framerate),
  "-start_number",
  "0",
  "-i",
  join(frames, "f%04d.png"),
  "-frames:v",
  String(count),
  "-filter_complex",
  `[0:v]null[shown];[shown]scale=${width}:${height}:flags=lanczos[out]`,
  "-map",
  "[out]",
  "-pix_fmt",
  "yuv420p",
  "-r",
  String(framerate),
];

const bitexact = ["-fflags", "+bitexact", "-flags:v", "+bitexact"];

async function run(args) {
  const said = await new Promise((settle) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-y", ...args]);
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => settle({ code, output }));
  });

  if (said.code !== 0) {
    console.error(said.output.trimEnd().split(/\r?\n/).slice(-8).join("\n"));
    process.exit(1);
  }
  return said.output;
}

/**
 * The clip as the Frames hold it, so that every encode is scored against what it
 * was made from rather than against another encode of it. FFV1 is lossless, and
 * scaling to the Artifact's size is not a loss any encoder is answerable for.
 */
const reference = join(out, "reference.mkv");
await run([...input, "-c:v", "ffv1", ...bitexact, reference]);

/**
 * One encode's quality, in VMAF.
 *
 * Both timebases are flattened to the frame index first, and that is not
 * decoration: an MP4 carries 1/15360 where Matroska carries 1/1000, and libvmaf
 * left to line them up by timestamp compares frames a Frame apart. It says so in
 * a warning it is easy to read past, and the score it then gives is wrong in the
 * direction that would have settled this the other way -- every MP4 in the first
 * run of this came out at VMAF 84 whatever its CRF, which is what a scrolling
 * clip held against itself one Frame late looks like.
 */
async function vmaf(file) {
  const said = await run([
    "-i",
    file,
    "-i",
    reference,
    "-lavfi",
    "[0:v]settb=AVTB,setpts=N[one];[1:v]settb=AVTB,setpts=N[two];[one][two]libvmaf=n_threads=8",
    "-f",
    "null",
    "-",
  ]);

  return Number(/VMAF score: ([\d.]+)/.exec(said)?.at(-1) ?? NaN);
}

/** What each format asks its encoder for, beside the CRF being swept. */
function encoder(format, crf) {
  return format === "mp4"
    ? ["-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-movflags", "+faststart"]
    : [
        "-c:v",
        "libvpx-vp9",
        "-crf",
        String(crf),
        "-b:v",
        "0",
        "-row-mt",
        "1",
        "-deadline",
        "good",
        "-cpu-used",
        "2",
      ];
}

console.log(`${count} Frames at ${width}x${height}, ${framerate}fps, from ${frames}`);
console.log("format,crf,bytes,vmaf,seconds");

for (const [format, crfs] of Object.entries(sweep)) {
  for (const crf of crfs) {
    const file = join(out, `${format}-${crf}.${format}`);
    const began = Date.now();
    await run([...input, ...encoder(format, crf), ...bitexact, file]);
    const seconds = ((Date.now() - began) / 1000).toFixed(1);

    console.log(
      `${format},${crf},${(await stat(file)).size},${(await vmaf(file)).toFixed(2)},${seconds}`,
    );
  }
}

await rm(reference, { force: true });
