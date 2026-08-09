# Tooling

Versions of the external tools this build depends on, as found on `PATH`.

Recorded **2026-08-09**.

| Tool | Version | Resolved from |
|---|---|---|
| node | 22.16.0 | `C:\nvm4w\nodejs\node.exe` |
| pnpm | 11.9.0 | `C:\nvm4w\nodejs\pnpm.ps1` |
| git | 2.49.0.windows.1 | `C:\Program Files\Git\cmd\git.exe` |
| ffmpeg | 8.1.1-full_build (Gyan) | `…\WinGet\Packages\Gyan.FFmpeg…\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe` |
| ffprobe | 8.1.1-full_build (Gyan) | `…\WinGet\Packages\Gyan.FFmpeg…\ffmpeg-8.1.1-full_build\bin\ffprobe.exe` |
| chrome-headless-shell | 151.0.7922.34 (Playwright build 1234) | `…\ms-playwright\chromium_headless_shell-1234\chrome-headless-shell-win64\` |

Notes:

- Node 22 supplies the test runner (`node --test`) and TOML is read with
  `smol-toml`, so the only workspace dependencies are TypeScript, `@types/node`
  and that parser.
- ffmpeg and ffprobe are not invoked yet — encoding and the assertions on
  encoded Artifacts arrive with the capture engine. They are recorded now
  because these are the versions the clock spike's size measurements in
  `spikes/clock-shim/README.md` came from.
- `chrome-headless-shell` is likewise not driven yet. Per ADR 0008 it must be
  the old headless shell rather than `chrome.exe`, and Playwright is the source
  of the pinned binary rather than the driver. The version above is the one the
  spike proved the clock against.
