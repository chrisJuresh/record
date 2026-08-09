# A local web app rather than a desktop app

The UI is a Svelte frontend served by a local Node server, opened in an ordinary
browser at a loopback address and launched from a `.cmd` shortcut. It is not an
Electron or Tauri application.

## Considered Options

- **Electron / Tauri** — would give a genuine application window and a single
  installable binary, at the cost of packaging, signing, and update machinery on
  two operating systems.

Something must spawn Chromium and ffmpeg and write to disk regardless, so a local
server exists under every option; the desktop shells only add a window around it.
Since the tool must work on Windows now and macOS later, and a loopback web app is
byte-identical on both, the desktop shells buy a nicer window for real
cross-platform cost. Previewing an MP4 or a GIF is also free in a browser and
fiddly in a custom shell.

## Consequences

There is no application window to close, no auto-update path, and the tool is
only usable while its server is running.
