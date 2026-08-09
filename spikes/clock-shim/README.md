# Spike: can the browser clock be stepped?

Throwaway code proving [ADR 0001](../../docs/adr/0001-deterministic-frame-stepping-is-the-only-capture-engine.md)
before anything was built on top of it. Kept as the evidence behind
[ADR 0008](../../docs/adr/0008-the-engine-drives-chrome-headless-shell-over-raw-cdp.md).
It is not the engine and nothing should import it.

Run order:

| Script | Question |
|---|---|
| `probe.mjs` | Which time-control mechanisms does this Chromium expose? |
| `diagnose.mjs` | Does virtual time advance by the budget requested? |
| `count-frames.mjs` | Does frame production scale with the budget? |
| `begin-frame.mjs` | Is `HeadlessExperimental.beginFrame` reachable, and on which binary? |
| `prove-clock.mjs` | Does one frame advance CSS, rAF and timers by exactly one interval? |
| `capture-scroll.mjs` | Does a real, image-heavy site capture deterministically? |
| `check-scroll.mjs` | Is the site quantising the scroll position we set? |

## What was measured

`Emulation.setVirtualTimePolicy` advances the clock exactly as budgeted — 16.66ms
per 16.67ms requested — but does **not** control the animation clock. rAF ticked
exactly twice per step whether the budget was 8ms, 16ms, 33ms or 100ms, each tick
advancing a fixed 16.67ms. Advancing virtual time without producing a frame never
returns.

`HeadlessExperimental.beginFrame` is absent from Chromium 151's new headless mode
and present in `chrome-headless-shell`. With both mechanisms driven together, on
the synthetic fixture:

```
priming frames:                    2 / 2 (stable)
divergence between mechanisms:     0.0 px
drift from the expected ramp:      0.0 px
setTimeout(500ms) fired at frame:  27 (expected ~28) stable
two runs byte-identical:           true
```

A CSS transition, CSS keyframes and a `requestAnimationFrame` loop animating the
same 1000ms ramp agreed to the pixel on every frame, and the ramp advanced
exactly 10px per frame — 600px over 60 frames, which is 1000ms at 60fps.

Against the photos grid at 1440x900 @2x, 171 frames of the scroll-peek motion:

```
images on page:          109/109 complete
distinct frames:         43 of 171
frames differing A vs B: 0
```

43 distinct frames is expected, not a defect: the holds repeat by definition, and
the eased travel down and back up passes through the same positions.

`scrollTop` is rounded to whole CSS pixels — requesting 0.57 yields 1, requesting
4.57 yields 5 — so the finest scroll step is 1 CSS pixel regardless of device
pixel ratio.

## Encoded output

From the same 171 frames: MP4 1280w/60fps at 1.11MB, WebM 1.72MB, GIF 800w/24fps
at 8.51MB, GIF 640w/20fps at 3.88MB. A photo grid is close to the worst case for
GIF, and the spec's default GIF settings should be read against that.
