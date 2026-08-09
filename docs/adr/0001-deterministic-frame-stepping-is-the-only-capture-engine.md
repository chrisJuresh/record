# Deterministic frame-stepping is the only capture engine

Clips are produced by driving a headless Chromium's clock forward one frame at a
time, positioning the page for that frame, capturing it, and handing the
resulting image sequence to ffmpeg — rather than recording the page as it plays
in real time. This costs roughly 30–60ms per Frame, and it cannot capture real
`<video>` playback, which no planned Action needs.

## Considered Options

- **Playwright's built-in video recording** — one line of code, but a fixed ~25fps
  WebM with no control over duration, resolution, or quality.
- **CDP screencast** — captures the page faithfully as it actually runs, including
  media playback, but frames are only emitted on repaint, so timing is uneven and
  smooth scrolling judders. Judder is the single most visible defect in the kind
  of clip this tool exists to make.
- **OS-level screen capture** — records a real browser window, but is
  non-deterministic, requires window management, and would need rebuilding for
  macOS.

An earlier draft of this design shipped frame-stepping *and* screencast as two
selectable modes. That was rejected as redundancy: two engines means two sets of
bugs and two behaviours to explain, for a fallback nothing currently requires.

## Consequences

Because output depends on the virtual clock rather than wall-clock time, CPU
contention cannot perturb a Run. Recording several Actions **in parallel is
therefore safe**, which it would not have been under any real-time engine.

The page's own animations do not advance on their own under a stepped clock. The
engine must shim the page's time sources so that CSS transitions and
`requestAnimationFrame` loops advance in lockstep with the Frame counter. If that
shim proves unreliable in practice, the honest response is to say so and revisit
this ADR — not to quietly reintroduce a second engine.
