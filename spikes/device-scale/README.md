# device-scale

Throwaway evidence behind issue #39: `viewport.device_scale_factor` was a
Setting the app drew a control for, `record configure` listed, and the capture
path ignored.

`node measure.mjs` launches a browser per combination of the launch switch
`--force-device-scale-factor` and the per-target
`Emulation.setDeviceMetricsOverride`, and reports the size of the PNG
`HeadlessExperimental.beginFrame` hands back against what the page believes its
own pixel ratio is.

Measured 2026-08-12, `chrome-headless-shell` 151.0.7922.34, at a CSS viewport of
400x300:

All sixteen rows, none elided:

| `--force-device-scale-factor` | override | frame | page `devicePixelRatio` |
|---|---|---|---|
| absent | absent | 800x600 | 1 |
| absent | 1 | 400x300 | 1 |
| absent | 2 | 400x300 | 2 |
| absent | 3 | 400x300 | 3 |
| 1 | absent | 800x600 | 1 |
| 1 | 1 | 400x300 | 1 |
| 1 | 2 | **400x300** | 2 |
| 1 | 3 | 400x300 | 3 |
| 2 | absent | 1600x1200 | 2 |
| 2 | 1 | 800x600 | 1 |
| 2 | 2 | **800x600** | 2 |
| 2 | 3 | 800x600 | 3 |
| 3 | absent | 2400x1800 | 3 |
| 3 | 1 | 1200x900 | 1.0000000298023224 |
| 3 | 2 | 1200x900 | 2.0000000596046448 |
| 3 | 3 | **1200x900** | 3 |

## What it settles

**The override decides what the page believes, and the launch switch decides
how large the image really is.** They are independent, and neither does the
other's job:

- `setDeviceMetricsOverride`'s `deviceScaleFactor` moves `devicePixelRatio` and
  nothing else. Every row that varies it alone returns the same 400x300 image.
  This is what the engine had been setting on its own, which is why the Setting
  bought no sharpness anywhere and never had.
- `--force-device-scale-factor=<n>` multiplies the returned image by `n`
  whatever the override says, and on its own leaves the page at the default
  800x600 window rather than the viewport the Project asked for.

So a Project photographed at scale `n` wants **both**: the switch at launch, so
the raster really is `n` times the CSS viewport, and the override, so the page
lays itself out as a high-density one — `devicePixelRatio` media queries,
`srcset`, canvas backing stores. A page rendered at ratio 1 and merely
upsampled would be four times the pixels and none of the detail.

The row that was the engine's behaviour is `1` / `2`: 400x300, which is what
the issue measured at the `photos` viewport as 1440x900.

## What it does not settle

`--force-device-scale-factor` is a **browser-wide** switch, so one browser can
no longer serve two viewports that differ in scale. That costs nothing here
because `openPage` launches a browser per page, but it is why the scale is an
argument to `openPage` rather than something set per target.

At scale 3 the page reports `1.0000000298023224` rather than `1` when the
override disagrees with the switch. Nothing reads that number, and the image
size is exact either way — but it is the reason not to believe the page about
its own ratio.
