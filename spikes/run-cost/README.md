# run-cost

Throwaway evidence behind issue #41: a Run was slow enough to discourage
re-recording, and the ticket's ladder of what to do about it had been read off
the code rather than measured.

`node measure.mjs` records a `scroll-peek`-shaped Action — 400 + 900 + 250 + 900
+ 400 milliseconds at 60fps, 171 kept Frames, 1440x900 inside `browser-light` —
against the fixture site, and times the stages `record run --progress` already
reports. Naming several Actions records them in one request; `CONCURRENCY=1`
records them one after another, which is what makes a per-Run cost visible
rather than hidden behind Runs sharing the machine.

It prints the Frame hashes and the Artifact sizes beside the timings, because
the bar for everything below is that neither may change.

Measured 2026-08-12, `chrome-headless-shell` 151.0.7922.34, ffmpeg 8.1.1, on the
machine in TOOLING.md.

## Where a Run's time goes

| | before | after |
|---|---|---|
| capture (browser, settling, 171 Frames) | 6745ms | **5514ms** |
| surround | 1329ms | 1311ms, then **~50ms** a Run |
| encode (three, in parallel) | 3987ms | 4158ms |
| one Run, end to end | 14151ms | **13066ms** |
| three Actions, `CONCURRENCY=1` | 41843ms | **35445ms** |

Same 171 Frame hashes and the same `mp4 127531, webm 93933, gif 267938` on both
sides of the change, which is the whole point: capture got cheaper without a
captured byte moving.

## What it settles

**Capture was rendering 62 images nobody kept.** 60 settling Frames and 2
priming ones ran before the first kept Frame, and every one of them asked for a
full PNG — 27% of the 233 images of this Run, rastered and encoded to be
dropped. Driving them without a screenshot is the 1.2s above.

**The surround is a fixed per-Run cost, not a per-Frame one.** 1.3s of every
Run, whatever the Action, because a second browser was launched to render the
same window again. It is a template laid out around a clip of a size, so the
Runs of one request now share it: the first still pays 1.3s and every Run after
it pays the 50ms of writing the image where ffmpeg can read it.

**The VP9 settings are not the problem the ticket suspected.** The three encodes
run in parallel, so the stage costs the slowest of them. Timed inside the
pipeline: mp4 2.8s, webm 3.6s, gif 2.1s — and roughly 1.0s of each is decoding
the PNG sequence and compositing, which all three pay alike. Re-encoding this
clip's own video with libvpx-vp9 at `-crf 32 -b:v 0 -row-mt 1`:

| | time | bytes |
|---|---|---|
| `-deadline good -cpu-used 2` (what ships) | 3231ms | 108709 |
| `-deadline good -cpu-used 3` | 3081ms | 115603 |
| `-deadline good -cpu-used 4` | 3257ms | 111977 |
| `-deadline good -cpu-used 5` | 3709ms | 102340 |
| `-deadline realtime -cpu-used 8` | 1303ms | **291998** |

Decoding accounts for ~1.0s of every row. So the reachable saving is about half
a second of a thirteen-second Run, and only the realtime row is worth more than
that — at 2.7 times the bytes, which would make the WebM larger than the MP4
beside it. The WebM is the source both the embed snippet and the app offer
first, so it is the last Artifact worth trading size on. Left as it is.

## What it does not settle

The three encodes still run at once, so a Run's encode stage costs the slowest
of them and the machine is doing all three at that moment. Nothing here measures
what they cost each other.

Nor does it say anything about capturing at fewer pixels, which is issue #39's
question and was settled there.
