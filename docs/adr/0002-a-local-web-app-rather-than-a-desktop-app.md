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

## Amended

The frontend is plain TypeScript modules compiled by `tsc` and served as they
are, rather than Svelte. Nothing else here changes: it is still an ordinary
browser at a loopback address, launched from a `.cmd` shortcut.

A framework means a bundler, and a bundler is a build step and a dependency tree
inside a workspace whose only dependencies are TypeScript, a type declaration
package and a TOML parser — and `pnpm build` is the typecheck, which plain
modules already are. What the app does is a rail of Projects, one clip on a
stage, and buttons that ask the server to record: one element tree redrawn from
one state, which is what a framework saves writing rather than what it makes
possible. The decision this record is about is the loopback web app against the
desktop shell, and that stands.
