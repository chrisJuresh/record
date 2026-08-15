# Every Run produces MP4, WebM, and GIF

Three Artifacts are encoded from the same captured Frames on every Run, at
different sizes: MP4 and WebM at full resolution and framerate, GIF smaller and
slower.

This is not redundancy — the delivery targets genuinely differ. GitHub strips
`<video>` elements out of README markdown and will not render a repository-relative
MP4 as a player, so **an animated GIF is the only Artifact that plays inline in a
README**. On an ordinary web page the opposite holds: a `<video>` element is far
smaller and better-looking than any GIF, wanting WebM for size and an MP4 source
as the fallback for older Safari.

## Consequences

GIF is the one Artifact that can balloon, and it is also the one most likely to be
seen, so its size levers — width and framerate — default well below the video
Artifacts' and are exposed for tuning. When a GIF is too large, width is reduced
before framerate: softness reads better than judder.

The two video Artifacts are the same clip, so they are **encoded to the same band
of quality** — the WebM's, because that is the one offered first. The MP4 is a
fallback for a browser rather than an archive of the clip, and the Frames it was
made from are deleted as soon as it exists, so there is nothing for headroom above
that band to be kept against. Neither encoder's CRF number means anything to the
other, and the two are chosen by what they produce rather than by how close
together they read (`spikes/encode-quality`).

Neither video Artifact's quality is a Parameter. The GIF's levers are Parameters
because the GIF balloons and because a README plays it; a lever on the videos
would mostly make two Runs harder to hold against each other. What the videos are
tuned by is `video_width`, which is the Project's, because how large a clip is
drawn is a property of the Project rather than of the motion in it.
