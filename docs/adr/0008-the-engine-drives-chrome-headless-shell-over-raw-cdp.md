# The engine drives chrome-headless-shell over raw CDP, not Playwright

Deterministic capture requires `HeadlessExperimental.beginFrame`, which produces
exactly one compositor frame at a caller-chosen timestamp and returns its
screenshot. That command is gated behind BeginFrameControl, which must be
requested when the target is created. Playwright creates its own targets and
offers no way to pass that flag, so the engine speaks to the DevTools socket
directly and launches the browser itself.

It must also be `chrome-headless-shell` — the old headless binary — not
`chrome.exe`. Both ship with Playwright's browser download, but in Chromium 151
the new headless mode reports `'HeadlessExperimental.beginFrame' wasn't found`
even with BeginFrameControl requested and the matching switch set. The old shell
answers it correctly. Playwright is therefore still worth keeping as the source
of pinned browser binaries; it is just not the driver.

## Considered Options

- **Playwright with `Emulation.setVirtualTimePolicy` alone.** Measured, and it
  does not work. Virtual time advances exactly as budgeted, but the animation
  clock is driven by *frames produced*, not by the budget: rAF ticked exactly
  twice per step at a fixed 16.67ms regardless of whether the budget was 8ms or
  100ms. Advancing virtual time without producing a frame deadlocks — the budget
  never expires. So the clock and the animation are coupled in a way the budget
  cannot control.
- **Shimming the page's time sources in JavaScript.** Would cover `setTimeout`,
  `Date.now` and `requestAnimationFrame`, but not CSS transitions or keyframes,
  which are driven by the compositor and not reachable from page script.

## Consequences

Both mechanisms are needed together, not either alone. `beginFrame` advances the
compositor clock, which covers CSS transitions, CSS keyframes and
`requestAnimationFrame`; virtual time is advanced by the same interval each frame
to move the timer queue, which covers `setTimeout`. With `beginFrame` only, a
`setTimeout` scheduled for 500ms never fires at all.

Frame time may only ever move forward. Asking for a frame at an earlier timestamp
than the last one wedges the compositor with no error, so the frame counter is
owned by the driver and callers can only ask for the next frame.

The compositor reports no damage until it has painted, so a fixed number of
priming frames runs before capture, and an undamaged frame returns no screenshot
and must be recorded as a repeat of the previous one rather than dropped.
`beginFrame` reports its damage whether or not a screenshot was asked for, so a
frame nothing keeps — the priming ones, and the settling ones capture drives
after them — is driven without asking for an image at all, and the same report
is what says the page has painted.

Chromium rounds `scrollTop` to whole CSS pixels, so the finest possible scroll
step is 1 CSS pixel regardless of device pixel ratio. Slow or short scrolls will
quantise. If that ever looks stepped, the fix is to translate the content rather
than scroll it — not to change the capture engine.

macOS will need its own `chrome-headless-shell` path and nothing else; the
mechanism itself is not platform-specific.
