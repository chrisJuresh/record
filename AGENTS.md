# record

A tool for producing short, repeatable video and image clips of locally-running
websites. Read [CONTEXT.md](./CONTEXT.md) for the vocabulary before writing
anything that names a domain concept.

## Layout

A pnpm workspace of TypeScript packages, built with project references.

- `packages/core/` — Timeline evaluation, Project configuration, Project
  lifecycle, the capture engine and encoding. The expressions evaluated inside a
  Project's own page live in `page.ts` and are used by both capture and Preview,
  so how a scroller is found is written once.
- `packages/fixture-site/` — the static site every test records against, and the
  harness that serves it on an ephemeral port. It also serves on a port of the
  test's choosing, as its own process, so that a test can configure a Project
  the tool has to start for itself.
- `apps/cli/` — the `record` command. **The CLI is the real interface**: the
  server and the UI reach the tool through these commands rather than around
  them, so a new operation is a command first.
- `apps/server/` — the local HTTP server `record serve` starts. It holds no
  capture, encoding or configuration logic of its own: every answer is the
  `record` command invoked and read back. The one exception is the **Preview
  origin** (ADR 0011), a proxy of one Project that a Preview is played through —
  and even its injected driver comes from the command. It imports nothing from
  `@record/core`, and it has **no test seam of its own** — it is asserted at the
  CLI seam, by starting it with the command and asking it over HTTP.
- `apps/app/` — the app the tool is used through: a page, a stylesheet and
  browser modules `tsc` compiles beside them, served by `record serve` at the
  root of it. Plain TypeScript rather than a framework, and no bundler
  (ADR 0002). It holds no logic of its own either — every button is one request
  to the server, which is one `record` command — and it has no test seam of its
  own for that reason.
- `projects/<name>/project.toml` — one configured Project. Hand-written, and
  edited a line at a time by the app, so the notes in it survive an edit made
  through it. Actions live beside it under `actions/`, as TypeScript modules
  the engine imports directly (ADR 0004) and `tsc --project projects`
  type-checks. Hand-tuned Parameter
  values sit next to each Action in `actions/<action>.overrides.toml` and never
  inside the module (ADR 0005). Nothing is ever written into a Project's own
  repository (ADR 0003).
- `runs/<project>/<action>/<run>/` — one directory per Run, named for the
  instant it began (ADR 0009). The ten most recent Runs of each Action are kept
  and older ones pruned. On this machine only, and never committed. A contact
  sheet of the Mockups lands beside them, under `mockups/`, where pruning does
  not reach it, and the Runs of a Matrix under `conditions/<condition>/`, each
  Condition keeping a Latest and a history of its own.
- `published/<project>/<action>/` — the tracked public directory `record
  publish` copies the Latest Artifacts of every Published Project into, and the
  only part of the workspace that is committed by the tool itself (ADR 0007).
  One public location serves every Project, so a clip of a private one is still
  linkable by URL. Nothing else is ever copied into it — no run history, and
  nothing of a Project that is not Published.
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
pnpm record configure photos
```

```bash
pnpm record configure photos published=true video_width=960
```

```bash
pnpm record add demo base_url=http://127.0.0.1:5173/ source_repository=C:\demo\site
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
pnpm record run photos scroll-peek --scheme light,dark
```

```bash
pnpm record run photos scroll-peek --width 480,900,1440
```

```bash
pnpm record parameters photos scroll-peek
```

```bash
pnpm record timeline photos scroll-peek
```

```bash
pnpm record timeline photos scroll-peek --set distance=600
```

```bash
pnpm record status
```

```bash
pnpm record mockups photos scroll-peek
```

```bash
pnpm record publish
```

```bash
pnpm record publish --confirm
```

```bash
pnpm record serve
```

```bash
pnpm record serve --open
```

On this machine that last one is `record.cmd` in the repository root, which is
double-clicked: it builds what has changed, starts the server, and opens the app.

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

### Reading a Timeline, and previewing it

`record timeline <project> <action>` says what an Action's Timeline evaluates
to: its framerate, how long it runs, how many Frames a Run of it would capture,
and where the page is on every one of them — the scroll position, the cursor
where there is one, the caption where there is one, and what that Frame does to
the page. It is the **same evaluation a Run captures from**, exposed rather than
reimplemented.

It records nothing and **writes nothing**, `--set` included: a value named here
is evaluated *as if* it applied. That is the difference between scrubbing and
tuning — the app asks for evaluations continuously while a control is moving,
and writes an Override only when the person settles on one, which is `record
set` exactly as it is today (ADR 0005).

The same command says whether the Action can be **previewed**, and which
primitive stops it where it cannot. A Preview drives the *live* Project, so an
Action containing a `click`, a `press`, a `type`, an `evaluate` or a `waitFor`
is refused rather than half-played: tuning an Action must never be able to
triage a real photo library, and a Preview that skipped the part somebody cared
about would be worse than no Preview. The rule lives with the evaluation, in the
tool — the app obeys and displays, and never decides.

`--preview` is the same answer with those refusals enforced, and one more: a
Project that is not answering at its ready URL is named, along with the URL.
**A Preview never starts a Project.** Only a Project this tool started is ever
stopped, and a Preview has no reliable moment of ending — a closed tab is not an
event the tool can act on — so starting one here would leak a process the rules
say it must eventually stop.

### Configuring a Project

Everything a Project says about itself — where it answers, how it is started,
what it is photographed at, which Mockup its clips are shown in, and whether
they are ever Published — is a setting `record configure` reads and writes.
`record configure <project>` says what it is configured with and what each
setting will take; naming settings as `name=value` changes them. **Adding a
setting is adding an entry** to the registry in `packages/core/src/configure.ts`,
which is the only place a setting is declared: the command lists a new one and
the app draws a control for it without being told twice. The one place outside
it that spells a setting's name is the form a Project is added from, which asks
for the two a Project cannot be configured without — and `record add` names what
is missing in its own words if that ever stops being true.

A change is written **into the file the Project is already configured in**, one
line at a time, so the notes a person left in `project.toml` survive an edit
made through the app — the key keeps its spelling, its indentation and whatever
was written after it. A setting given nothing at all is taken out of the file
and the tool's own value stands again; one a Project cannot record without is
changed rather than emptied.

Nothing is written until the whole file has been read back through the same
reader a Run reads it with, so **a setting the tool would refuse is refused
while the file still says what it said** rather than at record time, with the
refusal already saved. What a Project answers on has to be a URL, a path under
it has to be a path, a working directory has to be a directory on this machine,
and a Mockup has to be one there is.

`record add <project> <name>=<value>...` configures a Project this workspace
does not have yet, in a directory named for it under `projects/`. It cannot be
Published as it is added (ADR 0007): publishing is turned on afterwards, on a
Project that exists and has clips to look at.

#### What a Project is photographed at

`viewport.width` and `viewport.height` are **CSS pixels** — the page really is
that wide, and it is what the Timeline scrolls and clicks in.
`viewport.device_scale_factor` is how many pixels of Frame each of those is
captured as, and `video_width` is how wide the video Artifacts are then encoded.

A clip is sharp on a high-density display when `video_width` is above the CSS
width the page was laid out at, and the Frames really held that many pixels. So
the scale factor is what makes a wider `video_width` worth asking for: encoding
1440 CSS pixels at 2560 without it is upsampling detail that was never captured.
The two are set together or neither is worth setting.

It costs what it sounds like. Scale 2 is four times the pixels through every
screenshot, every PNG written and every encode, in a tool whose slowest part is
already capture — so **tune at scale 1 and record what is to be published at 2**,
rather than paying for it on every Run while a Parameter is being found.

What a Run was captured at is reported rather than inferred: `run.json` says the
Frame size and the scale, `record run` says both, and `record status` says what
the standing clip of each Action was captured at. Raising the scale factor does
**not** make an Action Stale — staleness is the Project's own repository, and
this setting lives in this workspace — so a clip recorded before it was raised
reads as current and is soft, which is exactly why `status` says the size.

### Matrix Runs

`--scheme light,dark` and `--width 480,900,1440` record one request across
varied **Conditions**, so that showing a theme or a responsive layout is not
maintaining near-identical duplicate Actions. Given together they multiply:
`--scheme light,dark --width 480,1200` is four Runs. Both work alongside a
Project or `--all` as well as one Action.

A Condition varies the circumstances the page is photographed under and never
what the Action does, which is why it is asked for at the command rather than
declared in the module — how a clip is lit is not motion. Every Condition is an
ordinary Run: it keeps a directory of its own under `conditions/<condition>/`,
prunes its own ten, and **queues for the machine beside every other Run** at
`--concurrency`, sharing one start of the Project with them. Because a Matrix is
several Runs however few Actions it names, it reports as a summary even for one
Action.

**Each Condition keeps a history of its own**, which
`record history <project> <action> <condition>` lists —
`record history <project> <action>` is the Action's own Runs and names the
Conditions beside them. They are deliberately not merged: every history is one
stream with one Latest, and folding them together would let an Action recorded
in light alone read as current while its dark clip went on being out of date.
For the same reason `record status` reports an Action against the Runs asked for
on their own, so an Action only ever recorded as a Matrix reads as never run
rather than as current — under-claiming, which is the direction staleness errs
in everywhere else.

Its Artifacts are named apart — `<action>-dark.mp4`, `<action>-light-480w.gif` —
because the clip of the light theme and the clip of the dark one are two clips,
and a README naming one must not be able to be handed the other.

Colour scheme is switched by telling the browser what the reader prefers, which
costs a Project built on `prefers-color-scheme` no configuration at all. A
Project that decides its own theme declares a **theme hook** instead, and it is
used **in preference to** the media query rather than as well as it:

```toml
[theme]
light = "document.documentElement.dataset.theme = 'light'"
dark = "document.documentElement.dataset.theme = 'dark'"
```

Both schemes are declared together, because a hook that can only go one way
would record the second Condition in the first one's theme. The expression is
evaluated once, after the page has loaded and before the first captured Frame,
and **a Run fails if the page rejects it** — a hook that quietly did nothing is
a clip of the wrong theme under a name claiming otherwise. As with replacement
copy, it is one pass rather than a standing instruction: an Action that
navigates with `.evaluate()` leaves the theme behind with the document it
switched.

Whether the page then *changes* is reported and never insisted on — a site with
one theme has one theme, and a Run says what the page it photographed reads as.
Emulating a width is not so forgiving: the viewport really is that wide, so a
narrower page is a taller clip at the Project's `video_width`, which is what
makes three widths comparable side by side.

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
<project> <action>` lists them, newest first, and a trailing Condition lists
that Condition's instead. Latest is the newest of them, so nothing reads a Run's
path off a template.

`record status` says which Actions have gone **Stale**: the Project's
`source_repository` has been committed to since that Action last ran. Only
commits count — a working tree is edited all day, so uncommitted changes are
deliberately not considered — and **staleness is reported, never acted on**. The
commits read are those of the repository *containing* `source_repository`, so a
Project that is one package of a larger repository is compared against that
repository. A Project under no repository at all cannot be told either way, and
`status` warns rather than reporting its Actions as current.

### Publishing

`record publish` copies the Latest Artifacts of every **Published** Project into
`published/` in this repository, commits them and pushes it. It is the one
irreversible, outward-facing operation the tool has and the only route by which
something private could become public, so it is **two requests rather than
one**: asked on its own it says exactly what would go public — every file, its
size, and the Project and Action it is the Latest of — and does none of it.
`--confirm` carries out that same plan, and `--dry-run` asks for the plan
outright. Confirmation is not a prompt on stdin: the server and the app read the
plan and then ask again, so nothing can hang waiting to be answered.

A Project that is not Published is in neither the plan nor the directory, and
that holds in both directions — a Project that **stops** being Published has its
clips taken back out and the removal committed, because a clip left behind is a
clip still public. `published/` is therefore the tool's own directory and is
**mirrored rather than added to**: what is in it afterwards is exactly the Latest
Artifacts of every Published Project, and nothing put there by hand survives a
publish. Everything it would take out is on the plan beside everything it would
put in, which is what makes that safe to confirm rather than surprising.
**Run history is never published**: what is copied is the
Latest of each history and nothing behind it, and each Condition of a Matrix
publishes its own Latest under the name it recorded apart as. Nothing else in a
Run's directory goes — the record it left of itself says where every Frame of it
came from on this machine.

Per ADR 0007 the only repository it writes to is this one. The commit names
`published/` as its pathspec, so work sitting staged or edited elsewhere in this
repository is not swept up by a button pressed without thinking, and no
Project's own repository is read from, written to, committed to or pushed.
Publishing what is already public commits nothing rather than failing, and this
repository is pushed **as it stands** — the branch it was on is reported, since
a publish onto a branch nobody reads is not a clip anybody can link to. A
repository that ignores `published/` is refused rather than published into:
every copy would succeed and nothing would reach anybody, which on this
operation reads exactly like having published.

### Serving

`record serve` puts the app and the same operations on HTTP, **bound to loopback
and nothing else** (ADR 0002), on a port the machine chooses unless `--port <n>`
names one. It says where it is answering and then holds the process open until
it is interrupted. `--open` opens the app in this machine's browser once it is
bound, which is what the shortcut does with it.

The server holds no recording logic. Every answer it gives is `record` invoked
with `--json` and read back, so there is no second place for a rule about
Projects, Runs or Artifacts to live, and **a failed Run is passed on in the
command's own words** rather than rephrased into something generic. It answers
requests addressed to a loopback name only: a page anywhere else must not be
able to drive a tool that starts processes on this machine.

| Path | What it is |
|---|---|
| `GET /` | The app, and every other path under it is a file it is made of |
| `GET /api` | What this server offers, for whoever is reading the API |
| `GET /api/projects` | `record projects` |
| `POST /api/projects` | `record add` |
| `GET /api/projects/<project>` | `record configure` |
| `POST /api/projects/<project>` | `record configure`, with settings to change |
| `GET /api/projects/<project>/actions` | `record actions` |
| `GET /api/projects/<project>/actions/<action>/parameters` | `record parameters` |
| `POST /api/projects/<project>/actions/<action>/parameters` | `record set` |
| `POST /api/projects/<project>/actions/<action>/parameters/reset` | `record reset` |
| `GET /api/mockups` | `record mockups` |
| `GET /api/timeline/<project>/<action>[?set=<name>=<value>]` | `record timeline` |
| `POST /api/preview` | `record timeline --preview`, and the Preview origin it is played through |
| `GET /api/publish` | `record publish` — what publishing would make public |
| `POST /api/publish` | `record publish --confirm`, and only for `{ confirm: true }` |
| `GET /api/status[?project=<project>]` | `record status` |
| `GET /api/history/<project>/<action>[/<condition>]` | `record history` |
| `POST /api/runs` | `record run`, answered before the Run is done |
| `GET /api/runs[/<id>]` | The Runs this server has been asked for |
| `GET /api/runs/<id>/events` | One Run's progress, as it happens |
| `GET /artifacts/<project>/<action>/[conditions/<condition>/]<run>/<file>` | What a Run left behind |

`POST /api/publish` takes `{ confirm: true }` and nothing else will do: a body
that does not confirm is answered `400` rather than read as an empty request to
publish, and what would go public is read at the same path without one.

The ones that write take `{ set: ["name=value"] }` and `{ reset: ["name"] }` —
the words the commands take — and each answers with the report the command gives
for itself, so a client reads what the Action will now run with, or what the
Project is now configured with, rather than assuming it got what it sent. A
value the command refuses is answered `400` in its own words, because "outside
the declared range 1..120" is what says what to send instead. `POST
/api/projects` takes `{ project, set }`: the Project to configure, and what to
configure it with.

`POST /api/runs` takes `{ project, action, all, schemes, widths, concurrency,
set }` — the same request `record run` takes — and answers `202` with the
request's id at once, because a Run takes long enough that holding the
connection open for it would be the hang this is meant to prevent. What it does
next arrives at `/events` as server-sent events: one `progress` event per stage,
then `recorded` or `failed` carrying the command's answer. A client that starts
watching late is caught up first, so it reads the whole Run rather than what was
left of it.

Progress comes from the command as well: `record run --progress` writes one JSON
object per line to stderr, under a `progress: ` prefix, saying which Run it is
about and what it has reached — `starting`, `capturing` (a Frame at a time),
`encoding`, and then `recorded` or `failed`.

Artifacts are served from the workspace's `runs/`, with byte ranges answered,
because playing a clip in a browser is what they are for.

`POST /api/preview` takes `{ project, action }` and is the one place this server
holds anything of its own (ADR 0011): a **Preview origin**, a proxy of that one
Project mounted at its root and bound to loopback, allocated the first time a
Preview of it is asked for. The app cannot script a page served on the Project's
own port, so the page comes back through an origin the app owns, carrying the
driver `record timeline` emitted. Even here the command decides everything that
can be decided — whether the Action can be driven, whether the Project is
answering, and what the driver is. The origin proxies that Project and nothing
else, passes every method through, and injects into HTML responses only.

Everything not addressed to `/api` or to `/artifacts` is the app. Those two are
the reserved names, so a file the app grows needs nothing added to the server,
and only what the app is made of — its page, its stylesheet, its modules — is
served out of its directory: the package also holds a manifest and the
TypeScript those modules were compiled from, and none of that is the app.

### The app

A section per Project in a rail, its Actions listed by name, and one clip on the
stage: the layout chosen from the prototype sheet. The rail can show a clip of
each Action under its name — the GIF, because it plays without being asked to —
and that is togglable, because eight of them playing at once is a busy sidebar.

The Latest plays inline **beside the Run before it**, because judging a change is
two clips rather than one, and each of them says the Project commit and the
effective Parameters it was recorded with — a clip nobody can place is a clip
nobody can judge — and what the Latest has that the Run before it did not is
marked on the Latest, so a difference reads with a direction. An Action recorded
only once says so where the second clip would be, and one never recorded says
that instead of standing an empty player there. The width the clips leave over is
where the Latest's Artifacts are read about rather than blank. Three buttons
record: one Action, every Action of a Project, and everything. Each is one
`POST /api/runs`, watched at `/events`, so what the app knows about a Run is what
the command said about it.

Beside them are the **Conditions** all three of them carry: a box per colour
scheme and a line of viewport widths, which reach the request as `schemes` and
`widths` and the command as `--scheme` and `--width`. What a scheme or a width is
stays the command's answer — the widths go as they were typed, and a Condition it
refuses comes back in its own words. They are ticked for the request being made
and remembered nowhere: a Project that always recorded both themes would be a
Setting, and staleness counts a Project's Runs rather than its declared
Conditions, so every Action of it would read as never recorded until that
changed. The clips on the stage do not move while a Matrix records, because every
Condition keeps a Latest and a history of its own — which is why the topbar says
how many Runs each Action is about to take before the button is pressed.

An Action gone **Stale** is flagged in the rail and said on the stage, which is
the other half of what a re-record button is for. The flag is `record status` and
nothing else: the app compares no commits of its own, and the answer is read again
as every request ends, so a Run recorded against the Project as it stands clears
the flag without anything being cleared by hand. Staleness the command could not
tell — a Project under no repository, an Action last recorded when there was no
commit to read — is said **in the command's own words**, because "not Stale" and
"cannot say" are not the same answer and only one of them means the clip stands.

A Run in flight says so on the Action it belongs to and on the stage, and a Frame
arriving rewrites those words rather than the page — redrawing a stage sixty
times a second would take the clip out from under whoever is watching it. A
failed Run shows **why, in the command's own words**, and leaves the previous
Latest playing: a failed Run took its own directory away with it, so the last
good clip is still there and still the one on the stage.

Every Parameter the Action on the stage declares is a control in the column
pinned right: a slider and a box for a number within its declared range, a menu
for an easing or a choice, a box to tick for a flag. Changing one writes an
Override to the sidecar at once — which is what the next Run reads, asked for
here or typed — and an Override is **marked as one** beside what the Action
declares, with a reset that removes it. A value the Action refuses is said in the
command's own words and the control goes back to what is really in the sidecar,
since a refused value was never written down. Overrides that could not be
applied — a Parameter the Action no longer declares, most of all — are surfaced
with the sidecar they are written in rather than left to be found: an Action
running on its declared default while its sidecar says otherwise reads as tuned.

What a Project is configured with is edited from the app too, on the stage in
place of the clips: a control per setting, marked where the file says it rather
than where the tool is standing a value in, and a **publish toggle** per Project.
Which settings there are is `record configure`'s answer rather than a list the
app keeps, so a Project that grows a setting grows a control. Changing one
writes into `project.toml` at once and the app is redrawn from what the command
answered — a setting the tool refuses is said in its own words and the control
goes back to what the file really says, since a refused setting was never
written. The rail configures a Project this machine does not have yet as well:
a name, where it answers and where its code is, which is `record add` and so is
never Published.

One button at the bottom of the page gets the clips onto GitHub, and it is the
only thing in the app that reaches off this machine. Pressing it puts the
**plan** on the stage rather than publishing: every file, its size, and the
Project and Action it is the Latest of, along with whatever would be taken back
out. The plan is read again every time it is asked for rather than kept, since a
plan drawn from an older answer is one somebody would be confirming blind, and
publishing is a second press under a list that has been read. It is
`record publish` and `record publish --confirm` and nothing else: the app
compares no Projects and copies no files of its own.

A **Preview** takes the stage in place of the clips, and gives it back. It is the
Action played live against the running Project — the app replays the states
`record timeline` evaluated, over the Project itself, at the Project's own
viewport transform-scaled to whatever room the stage has. It loops, it scrubs,
and moving a Parameter re-asks for the evaluated Timeline and replays it without
writing anything, so a value is found by feel and written down only once it is
settled on. It says on its face that it is not the clip, and that framerate is
the one Parameter it cannot answer. The app holds no Timeline logic of its own:
an easing implemented here would be a second implementation of one.

The frame the Project is played in is created **once** when a Preview is turned
on and only ever messaged afterwards — moving an iframe in the document reloads
it, and a slider let go of must not reload the site under whoever is tuning it.

Tuning redraws that column and the Preview, configuration only its own panel and
the Published pill beside the Project it belongs to, publishing only its own
panel, and staleness only the flags it is written into. Clips are playing beside
all four, and neither a slider let go of nor a Stale flag arriving may put a new
video element in the page.

They are read for the Action on the stage rather than for all of them, because
reading them imports the Action's module.

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

Six Parameters arrive without being declared, because they describe what is
drawn around the Frames and how they are encoded rather than what moves, and an
Action describes motion:

- `cursor` — `auto`, `shown` or `hidden`.
- `cursorStyle` — `soft-dot`, `arrow-light` or `arrow-dark`.
- `cursorCaptions` — off.
- `mockup` — the Project's own choice, which is `auto` unless it said otherwise.
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

### Mockups

A **Mockup** is the decorative surround composited around the Frames — a
browser window, a laptop, a phone — so that a clip looks deliberate rather than
like a cropped screenshot. It is an HTML/CSS template rendered once by the same
browser into a transparent image with an **Aperture** cut through it, and the
Frames are composited into that Aperture on the way to the Artifacts
(ADR 0010). Nothing about it is drawn into the page: a surround inside the
Frames is a surround the page can scroll underneath.

Rendered **once per request** rather than once per Run: the image is a template
laid out around a clip of a size and nothing of the Frames reaches it, so every
Run of `record run --all` that agrees on the Mockup and on the size shares the
one rendering, and a Condition photographed at another width gets its own.

A Project chooses one, and any of its Actions may override it:

```toml
mockup = "browser-light"
```

```bash
pnpm record run photos scroll-peek --set mockup=laptop
```

`auto` is the default and asks the page: a page that paints itself dark is shown
in `browser-dark`, and everything else in `browser-light`. The rest are `none`,
`rounded`, `browser-light`, `browser-dark`, `laptop` and `phone`. `phone` is
portrait whatever the clip is, so a landscape clip is cropped to the middle of
it — recording at a phone viewport is what fills it.

An Artifact keeps the width it was asked for whichever Mockup it is in, so a
surround costs room inside the clip rather than around it. Compositing does not
perturb determinism: two Runs of an unchanged Action inside a Mockup are the
same bytes, exactly as they are without one.

**Adding a Mockup is adding an entry** to the registry in
`packages/core/src/mockup.ts` — a name, a line about what it costs, a backdrop
and a document. Nothing outside the registry names a template, and
`record mockups <project> <action>` renders every one of them around a real
Frame of an Action to show it. `record mockups` on its own lists them.

Silhouettes are generic rather than modelled on identifiable hardware, because
Published clips are public.

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

The server is asserted at the CLI seam too, in `apps/cli/test/server.test.ts`:
it is started by running `record serve`, asked over HTTP, and what it says is
held against what the command says for itself. It gets no seam of its own
because it holds no logic of its own.

So is the app, in `apps/cli/test/app.test.ts`, and as far as the same seam
reaches: the page the tool is opened at, the modules it loads, and the fact that
nothing else in that package is readable over loopback. What those modules draw
is held to by `pnpm build` and by opening it.

The Preview origin is asserted the same way, in `apps/cli/test/preview.test.ts`:
started by running `record serve`, then asked over HTTP against the fixture
site — a page carrying the driver, a stylesheet untouched, the site's own
absolute URLs resolving through it, anything outside the Project refused, and a
loopback `Host` and nothing else. The app's player gets no seam, for the same
reason nothing else the app draws has one. If a rule about a Preview needs
asserting, that is the signal it belongs in `record timeline` instead — which is
where previewability is, and where it is tested.

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

### Skill pipeline

Decisions come from `/grilling`, a spec from `/to-spec`, tickets from
`/to-tickets`, and code from `/implement` against one ticket in a fresh context.
**A thinking session ends at decisions**: being told to decide is not being told
to build, and a spike is a ticket rather than a detour. See
`docs/agents/skill-pipeline.md`.

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
while it is still cheap to change. This says what to do once there is a commit;
whether there should be one at all is the skill pipeline's question, and the
answer during a thinking session is no. Only the merge waits: agents open, push to
and update PRs and answer review comments on them, and never merge or close the
issue behind the PR's back.

### Triage labels

The five canonical triage roles, each label string equal to its name, plus a
`bug`/`enhancement` category role on every triaged issue. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
