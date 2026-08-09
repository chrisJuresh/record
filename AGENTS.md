# record

A tool for producing short, repeatable video and image clips of locally-running
websites. Read [CONTEXT.md](./CONTEXT.md) for the vocabulary before writing
anything that names a domain concept.

## Layout

A pnpm workspace of TypeScript packages, built with project references.

- `packages/core/` — Timeline evaluation, Project configuration, the capture
  engine and encoding.
- `packages/fixture-site/` — the static site every test records against, and the
  harness that serves it on an ephemeral port.
- `apps/cli/` — the `record` command. **The CLI is the real interface**: the
  server and the UI will reach the tool through these commands rather than
  around them, so a new operation is a command first.
- `projects/<name>/project.toml` — one configured Project. Actions live beside
  it under `actions/`, as TypeScript modules the engine imports directly
  (ADR 0004) and `tsc --project projects` type-checks. Hand-tuned Parameter
  values sit next to each Action in `actions/<action>.overrides.toml` and never
  inside the module (ADR 0005). Nothing is ever written into a Project's own
  repository (ADR 0003).
- `runs/` — what Runs produce, on this machine only and never committed.
- `spikes/` — throwaway evidence behind an ADR. Not the engine; nothing imports
  it.

External tool versions are recorded in [TOOLING.md](./TOOLING.md).

## Running and verifying

```bash
pnpm install && pnpm build
```

`pnpm build` is also the typecheck — there is no separate step. Tests are
Node's own runner over the compiled output, so `pnpm test` builds first.

```bash
pnpm test
```

A single test file is quick to run directly, once built:

```bash
node --enable-source-maps --test apps/cli/dist/test/cli.test.js
```

```bash
pnpm record projects
```

```bash
pnpm record run photos scroll-peek
```

```bash
pnpm record parameters photos scroll-peek
```

`record` reads its Projects from `$RECORD_WORKSPACE`, defaulting to this
checkout. Tests set it to a workspace of their own — **no test may depend on a
real Project being present, and none may read the photo vault.**

Recording needs the Project already answering on its base URL; starting one is
not the tool's job yet. It also needs `chrome-headless-shell` and `ffmpeg`,
which are found on this machine unless `$RECORD_CHROME` or `$RECORD_FFMPEG`
name a copy. Frames land under `runs/<project>/<action>/` and are deleted as
soon as they have been encoded, leaving the three Artifacts every Run produces —
`<action>.mp4`, `<action>.webm` and `<action>.gif` (ADR 0006) — and
`<action>.embed.html`, the video element naming both video sources.

## Writing an Action

An Action is a TypeScript module at `projects/<project>/actions/<name>.ts`
default-exporting an `Action`. It declares its Parameters, builds a Timeline
from them, and imports nothing but `@record/core` — an Action describes motion
and reaches for nothing on this machine.

```ts
import { motion, type Action } from "@record/core";

const parameters = {
  hold: {
    kind: "number",
    describes: "Still at either end, in milliseconds",
    default: 400,
    min: 0,
    max: 2000,
  },
  distance: {
    kind: "number",
    describes: "How far down the page travels, in CSS pixels",
    default: 180,
    min: 20,
    max: 2000,
  },
  travel: {
    kind: "number",
    describes: "How long the travel takes, in milliseconds",
    default: 900,
    min: 100,
    max: 5000,
  },
  framerate: { kind: "number", describes: "Frames per second", default: 60, min: 10, max: 120 },
  easing: { kind: "easing", describes: "How the travel settles", default: "ease-in-out-cubic" },
} as const;

const scrollPeek: Action<typeof parameters> = {
  parameters,
  timeline({ hold, distance, travel, framerate, easing }) {
    return motion({ framerate })
      .hold(hold)
      .scrollTo(distance, { durationMs: travel, easing })
      .hold(hold);
  },
};

export default scrollPeek;
```

Every number in that Timeline arrives as a Parameter. That is the rule, not the
example being thorough.

### Declaring Parameters

Every tunable value is declared, so that it reaches the UI as a usable control
rather than a raw number box. `as const` is what gives `timeline` a value for
each Parameter under its own name.

- `{ kind: "number", describes, default, min, max }` — a distance, a duration,
  a framerate. The default must lie inside the range, or the Action fails to
  run.
- `{ kind: "easing", describes, default }` — one of `linear`, `ease-in-cubic`,
  `ease-out-cubic`, `ease-in-out-cubic`.

`describes` is read by the person tuning the Action, so write it for them.

### Parameters every Action carries

Two Parameters arrive without being declared, because they describe how the
Frames are encoded rather than what moves, and an Action describes motion:

- `gifWidth` — 640, between 120 and 1920.
- `gifFramerate` — 20, between 5 and 50.

The GIF is the one Artifact that can balloon and the only one a README plays
(ADR 0006), so its size levers are tunable per Action — `record set photos
scroll-peek gifWidth=480` — without any Action mentioning them. **Declaring
either name in an Action is refused**, because two declarations of one name
leave no way to say which an Override meant. The video Artifacts keep the
Project's `video_width` and the Timeline's framerate.

### The primitives

`motion({ framerate, startsAt })` begins a Timeline and every primitive returns
another one. `startsAt` defaults to `{ scrollTop: 0, cursor: null }`; an Action
that moves or clicks a cursor has to declare where the cursor starts, because
no Frame contains a real pointer to ask about.

| Primitive | What it adds to the Timeline |
|---|---|
| `.hold(durationMs)` | A Hold: nothing moves. |
| `.scrollTo(scrollTop, { durationMs, easing })` | Travel to a scroll position. |
| `.scrollBy(distance, { durationMs, easing })` | Travel that far from wherever the Timeline has reached. |
| `.moveCursorTo({ x, y }, { durationMs, easing })` | Carry the cursor across the viewport, in CSS pixels. |
| `.click({ durationMs })` | Press and release where the cursor is. |
| `.press(key, { durationMs })` | One keystroke: a letter, a digit, or `Enter`, `Escape`, `Tab`, `Space`, `Backspace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `ArrowUp`/`Down`/`Left`/`Right`. The key is typed, so a wrong name fails `pnpm build`. |
| `.type(text, { perKeyMs })` | Type into whatever has focus, one keystroke per character. |
| `.waitFor(condition, { durationMs, describes })` | Hold, and fail the Run if the condition has not become true by the end of it. |
| `.evaluate(expression)` | The escape hatch (ADR 0004): an expression run in the page, taking no time at all. |

Every option carries a default except `waitFor`'s `durationMs` and the
`durationMs` of the three travels — `easing` defaults to `ease-in-out-cubic`,
`click` and `press` to 120ms, `type` to 90ms a character.

The escape hatch is an expression evaluated in the page, not a handle on it:
nothing comes back, because Timeline evaluation happens before any browser
exists. Reach for it to *do* something the primitives cannot say, and use
`waitFor` to find out whether it worked.

### Conventions

- **Declare every timing value as a Parameter.** A duration written inline is a
  duration nobody can tune.
- **Hold at both ends.** A looping clip has to pause rather than snap back.
- **A wait declares how long it waits.** `waitFor` occupies the span it was
  given whatever the page does, and then checks — a wait whose length depended
  on the page would make two Runs of one Action different lengths. A wait too
  short to occupy a Frame is refused rather than rounded away.
- **Nothing after the last Frame happens.** A Timeline ending in `.evaluate()`
  ends in a no-op: there is no Frame left to run it before. Put an ending Hold
  after it, which a looping clip wants anyway.
- **Reach for `evaluate` last.** It is there for what the primitives cannot say,
  not for what they say verbosely.
- **Never write a tuned value into the module.** Overrides belong in the sidecar
  (ADR 0005): `record set <project> <action> distance=240` writes one,
  `record reset <project> <action> distance` removes it, and
  `record parameters <project> <action>` shows what an Action will run with.
  `record run <project> <action> --set distance=240` does both at once.

## Testing

There are exactly two seams, and tests live only at them:

- **The CLI seam** (`apps/cli/test/`) — almost all behaviour, asserted by
  running the built command and reading its `--json` output.
- **The Timeline evaluation seam** (`packages/core/test/`) — easings, Hold
  boundaries, duration rounding and Override application, with no browser
  involved.

`packages/fixture-site/test/` is the one exception, and it tests the harness
rather than the tool: a fixture site that quietly stopped serving would weaken
every assertion made against it, determinism most of all.

Assert on what is observable from outside: the files a Run produced, the plan a
publish would carry out. A test that reaches into an intermediate structure the
operator cannot see will be rejected in review.

The CLI seam launches a real browser and a real encoder, so its Actions are kept
small — a test Action asserts the same behaviour as a real one in a tenth of the
Frames. Determinism is asserted on the **hashes** of Frames, never on stored
images, which is also all a Run leaves behind.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `chrisJuresh/record`, driven through the
`gh` CLI. Blocking is expressed with GitHub's native issue dependencies, not only
as prose. See `docs/agents/issue-tracker.md`.

**Every issue resolved by a code change lands through a pull request** — a
branch named `<issue-number>-<slug>`, a PR opened at the first push whose body
says `Closes #<number>`, and a merge that closes the issue. Nothing is committed
to `main` directly, and no agent merges or closes on its own.

### Triage labels

The five canonical triage roles, each label string equal to its name, plus a
`bug`/`enhancement` category role on every triaged issue. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
