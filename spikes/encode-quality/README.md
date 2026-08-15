# encode-quality

Throwaway evidence behind the MP4's quality target. `formatArguments` asked
libx264 for `-crf 18` and libvpx-vp9 for `-crf 32`, and nothing said what either
was chosen to hit — read side by side they look like one Artifact held to a far
higher standard than the other, which is the reading this set out to check.

`node measure.mjs <frames> [width] [height]` encodes a directory of captured
Frames through the same filter chain `encode.ts` builds, once per CRF per
encoder, and scores every result against a lossless reference made from those
same Frames. Bytes and VMAF are the only pair that lets 22 of x264 be held
against 32 of VP9: the CRF numbers are on scales that have nothing to say to
each other.

A Run deletes its Frames as soon as they are encoded, so getting a directory of
them means stopping it: comment out the `rm(frames, ...)` in `run.ts` and record
once. These are 171 Frames of `photos` `scroll-peek` at 1440x900, 60fps — the
same clip #41 was measured on, and the hardest content this tool has, since a
grid of photographs scrolling at 60fps is nearly all detail and nearly all
motion.

Measured 2026-08-15, ffmpeg 8.1.1 with libvmaf, on the machine in TOOLING.md.

## What each CRF buys

At 1280x800, which is the `video_width` a Project gets unless it says otherwise:

| | bytes | VMAF |
|---|---|---|
| `mp4 -crf 18` | 1276130 | 97.77 |
| `mp4 -crf 20` | 1013327 | 97.50 |
| `mp4 -crf 21` | 900618 | 97.32 |
| **`mp4 -crf 22`** | **801100** | **97.08** |
| `mp4 -crf 23` | 712524 | 96.80 |
| `mp4 -crf 24` | 634150 | 96.42 |
| `mp4 -crf 26` | 504172 | 95.53 |
| `mp4 -crf 28` | 400789 | 94.17 |
| `webm -crf 28` | 773539 | 98.05 |
| `webm -crf 30` | 705647 | 97.99 |
| **`webm -crf 32`** | **610528** | **97.87** |
| `webm -crf 34` | 537296 | 97.72 |

And at 1440x900, the size these Frames were captured at:

| | bytes | VMAF |
|---|---|---|
| `mp4 -crf 18` | 1435219 | 98.12 |
| `mp4 -crf 20` | 1200926 | 97.92 |
| `mp4 -crf 21` | 1092730 | 97.79 |
| **`mp4 -crf 22`** | **996068** | **97.59** |
| `mp4 -crf 23` | 907380 | 97.43 |
| `mp4 -crf 24` | 823620 | 97.17 |
| `mp4 -crf 26` | 676055 | 96.55 |
| `mp4 -crf 28` | 546823 | 95.67 |
| `webm -crf 28` | 761855 | 98.10 |
| `webm -crf 30` | 705559 | 98.03 |
| **`webm -crf 32`** | **631781** | **97.89** |
| `webm -crf 34` | 572047 | 97.78 |

## What it settles

**The two encodes were never asymmetric in quality.** `-crf 18` and `-crf 32`
land within a quarter of a VMAF point of each other — 0.10 under the WebM at
1280, 0.23 over it at 1440 — which is close enough that the sign of the
difference is not stable across a resize, never mind visible. Twelve CRF numbers
apart on paper, the same clip in practice. The size gap they were suspected of
causing is VP9 being the better codec: the MP4 spent 2.1 to 2.3 times the
WebM's bytes arriving in the same place.

**The 18 was the wrong target, for a different reason.** It is an archival
number, and no Artifact here is an archive. The Frames are deleted as soon as
they are encoded, and the MP4 exists to be played by the browsers that cannot
play the WebM (ADR 0006) — so there is nothing that headroom above the WebM's
own band could be kept against. Encoded at 22 the fallback lands 0.79 VMAF under
the WebM at 1280 and 0.30 under it at 1440, and loses a third of its bytes:
1276130 to 801100, and 1435219 to 996068.

A third of every MP4 this tool has written, for a difference no one can see —
the crops at both settings are indistinguishable at 1:1 beside the lossless
reference, which is what the VMAF is saying too.

**22 rather than 23 or 24.** The whole sweep from 18 to 28 sits inside the band
where VMAF stops discriminating, so the number was chosen at the last step whose
distance from the WebM stays under a point at both sizes. 23 crosses it at 1280.

**libvmaf will quietly compare the wrong Frames.** An MP4 carries a 1/15360
timebase where Matroska carries 1/1000, and left to line the two up by timestamp
libvmaf pairs each Frame with its neighbour. It warns, in a line that is easy to
read past, and then scores every MP4 at VMAF 84 whatever its CRF — a flat column
that reads exactly like x264 being hopeless at this content. The first run of
this spike said the MP4 was 13 points below the WebM, which is how nearly it
settled the question backwards. `settb=AVTB,setpts=N` on both inputs is what
makes the comparison a comparison.

## What it does not settle

Nothing here measures the WebM's own target. 32 stays where #41 left it: it is
the Artifact both the embed snippet and the app offer first, so it is the last
one worth trading size on.

Nor is one clip every clip. The photos grid is the worst case on purpose, and a
clip of a mostly-static page will sit somewhere else on both axes — though a
flatter clip is cheaper for both encoders, so the ratio between them is what
would move, not the finding that the two land in the same band.

It also does not reproduce the 5.4x MP4-to-WebM ratio that prompted this. These
Frames give 2.1x at 1280 and 2.3x at 1440 under the settings that shipped. A
clip that reaches 5.4x is holding something these 171 Frames do not, and it was
not identified here.
