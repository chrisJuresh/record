# record

A tool for producing short, repeatable video and image clips of locally-running
websites. Read [CONTEXT.md](./CONTEXT.md) for the vocabulary before writing
anything that names a domain concept.

## Layout

A pnpm workspace of TypeScript packages, built with project references.

- `packages/core/` — Timeline evaluation, Project configuration, Project
  lifecycle, the capture engine and encoding.
- `packages/fixture-site/` — the static site every test records against, and the
  harness that serves it on an ephemeral port. It also serves on a port of the
  test's choosing, as its own process, so that a test can configure a Project
  the tool has to start for itself.
- `apps/cli/` — the `record` command. **The CLI is the real interface**: the
  server and the UI will reach the tool through these commands rather than
  around them, so a new operation is a command first.
- `projects/<name>/project.toml` — one configured Project. Actions live beside
  it under `actions/`, as TypeScript modules the engine imports directly
  (ADR 0004) and `tsc --project projects` type-checks. Hand-tuned Parameter
  values sit next to each Action in `actions/<action>.overrides.toml` and never
  inside the module (ADR 0005). Nothing is ever written into a Project's own
  repository (ADR 0003).
- `runs/<project>/<action>/<run>/` — one directory per Run, named for the
  instant it began (ADR 0009). The ten most recent Runs of each Action are kept
  and older ones pruned. On this machine only, and never committed.
- `spikes/` — throwaway evidence behind a decision: what an ADR was settled by,
  and the prototype sheets a design choice was made from. Not the engine;
  nothing imports it.

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
pnpm record run photos
```

```bash
pnpm record run --all
```

```bash
pnpm record parameters photos scroll-peek
```

```bash
pnpm record status
```

`record` reads its Projects from `$RECORD_WORKSPACE`, defaulting to this
checkout. Tests set it to a workspace of their own — **no test may depend on a
real Project being present, and none may read the photo vault.**

Recording health-checks the Project at its ready URL — `base_url` joined with
`ready_path` — before anything else. A Project already answering is recorded as
it stands and **left running**, because it is almost certainly the one you had
open. One that is not answering is started from its `start_command` in its
`working_directory`, waited for until `ready_timeout_ms` runs out, and stopped
once the Run ends, however it ended. **Only a Project this tool started is ever
stopped.**

`record run <project>` records every Action in a Project and `record run --all`
records every Action of every Project, **four at a time** unless
`--concurrency <n>` says otherwise. Recording concurrently cannot change what is
recorded, because a Run's output depends on the stepped clock rather than on
wall-clock time (ADR 0001) — the Artifacts are byte-identical to the same
Actions recorded one at a time, which the CLI seam asserts. A Project needing to
be started is started **once** and shared by every Action recording against it,
and stopped when the last of them is done. **One Action failing does not abandon
the others**: the rest record, the summary names what failed, and the command
still fails.

Recording also needs `chrome-headless-shell` and `ffmpeg`, which are found on
this machine unless `$RECORD_CHROME` or `$RECORD_FFMPEG` name a copy. Every Run
gets a directory of its own. Frames land in it and are deleted as soon as they
have been encoded, leaving the three Artifacts every Run produces —
`<action>.mp4`, `<action>.webm` and `<action>.gif` (ADR 0006) —
`<action>.embed.html`, the video element naming both video sources, and
`run.json`, the record of what the Run was produced under. **A Run that fails
takes its own directory away with it**, so the last good Run's Artifacts are
exactly as they were. Encoding is bit-exact, so an Artifact is a function of the
Frames it was encoded from and nothing else — two Runs of an unchanged Action
produce the same bytes rather than files stamped with the moment they were
written.

Runs are not disposable (ADR 0009). Each keeps its timestamp, the Project's
commit at the time, the effective Parameters and the versions of the tools that
made it, and the ten most recent Runs of an Action survive — `record history
<project> <action>` lists them, newest first. Latest is the newest of them, so
nothing reads a Run's path off a template.

`record status` says which Actions have gone **Stale**: the Project's
`source_repository` has been committed to since that Action last ran. Only
commits count — a working tree is edited all day, so uncommitted changes are
deliberately not considered — and **staleness is reported, never acted on**. The
commits read are those of the repository *containing* `source_repository`, so a
Project that is one package of a larger repository is compared against that
repository. A Project under no repository at all cannot be told either way, and
`status` warns rather than reporting its Actions as current.

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
- `{ kind: "choice", describes, default, choices }` — one of a named set, so
  tuning it is picking rather than spelling. The default has to be one of them.
- `{ kind: "flag", describes, default }` — on or off, set as `name=true` or
  `name=false`.

`describes` is read by the person tuning the Action, so write it for them.

### Parameters every Action carries

Five Parameters arrive without being declared, because they describe what is
drawn over the Frames and how they are encoded rather than what moves, and an
Action describes motion:

- `cursor` — `auto`, `shown` or `hidden`.
- `cursorStyle` — `soft-dot`, `arrow-light` or `arrow-dark`.
- `cursorCaptions` — off.
- `gifWidth` — 640, between 120 and 1920.
- `gifFramerate` — 20, between 5 and 50.

The GIF is the one Artifact that can balloon and the only one a README plays
(ADR 0006), so its size levers are tunable per Action — `record set photos
scroll-peek gifWidth=480` — without any Action mentioning them. **Declaring any
of these names in an Action is refused**, because two declarations of one name
leave no way to say which an Override meant. The video Artifacts keep the
Project's `video_width` and the Timeline's framerate.

### The drawn cursor

No Frame contains the operating system's pointer and there is no real mouse in
a stepped headless browser, so a cursor is **drawn**: an overlay injected into
the page before its own scripts run, positioned each Frame from the evaluated
Timeline. Where it is, whether it is held down, how far each click's ripple has
spread and which keys were struck near a Frame are all decided by Timeline
evaluation, so two Runs of one Action draw the same cursor in the same places —
an animation left to the page would draw whatever the page felt like that time.

`cursor` is `auto` by default, which draws one for an Action containing a
`click` or a `type` primitive and none for an Action that only travels, so a
pointer never sits idle in frame. `shown` and `hidden` say so outright, and an
Action asked to show a cursor it never placed fails rather than drawing nothing
— **an Action that shows a cursor declares where it starts**, as
`motion({ startsAt: { cursor } })`.

`cursorCaptions` puts the keys an Action strikes on screen, gathered into the
burst that typed them and lingering a moment after the last of them. It is off
until it is turned on: a clip explaining a shortcut wants it and a clip of a
form being filled in does not.

The styles are a registry in `packages/core/src/cursor.ts` — a shape, where its
point sits inside it, how far it shrinks under a press, and the ring a click
sends out. **Adding a cursor is adding an entry**: nothing outside the registry
names a style, so a new one is settable the moment it is written.

### The primitives

`motion({ framerate, startsAt })` begins a Timeline and every primitive returns
another one. `startsAt` defaults to `{ scrollTop: 0, cursor: null }`; an Action
that moves, clicks or draws a cursor has to declare where the cursor starts,
because no Frame contains a real pointer to ask about.

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

### Text overrides

An Action can also declare **replacement copy**, so a clip shows the wording it
was meant to show rather than whatever the running site happens to contain that
day. It is a mapping from element selector to copy, declared beside the Timeline
rather than inside it, because what the page says is not something a Frame does.

```ts
const lightbox: Action<typeof parameters> = {
  parameters,
  text: {
    "#heading": "Everything, in one place",
    ".card:first-child h2": "Shipped this morning",
  },
  timeline({ hold }) {
    return motion({ framerate: 60 }).hold(hold);
  },
};
```

The copy is substituted once, after the page has loaded and before the first
captured Frame, so the Frames are photographs of the page as reworded. A field's
copy becomes its value and everything else's becomes its text, because copy
written into an input is copy nobody can see. Substitution is decided entirely
by the declaration, so it cannot make two Runs of one Action differ — and a Run
reports what it substituted and how many elements each selector matched, so a
clip showing wording the site never had says where that wording came from.

**A selector matching nothing fails the Run**, naming the selector, as does one
the page cannot read. Copy that quietly failed to land is a clip of the wrong
words, which is the one outcome worse than not recording at all. A page that
writes its own copy after load will overwrite what was substituted; that is what
`.evaluate()` and `.waitFor()` are for.

This is a presentation feature and **not a privacy one**. Nothing here redacts
anything — a Project whose content must not be exposed stays unpublished
(ADR 0007).

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
- **Declare replacement copy, never type it into the site.** `text` is how a
  clip shows intended wording; editing the running Project to record it is a
  change somebody has to remember to undo.
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
branch named `<issue-number>-<slug>`, a PR whose body says `Closes #<number>`,
and a merge that closes the issue. Nothing is committed to `main` directly.

**Committing is not delivering.** An agent that has committed against an issue
**pushes the branch and opens the PR itself**, unasked — work left on a local
branch is work nobody can see, and a PR opened early is where the diff is read
while it is still cheap to change. Only the merge waits: agents open, push to
and update PRs and answer review comments on them, and never merge or close the
issue behind the PR's back.

### Triage labels

The five canonical triage roles, each label string equal to its name, plus a
`bug`/`enhancement` category role on every triaged issue. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
