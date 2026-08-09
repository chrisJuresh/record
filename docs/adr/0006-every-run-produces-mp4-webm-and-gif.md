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
