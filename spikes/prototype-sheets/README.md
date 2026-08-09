# Spike: what should this look like?

Two throwaway sheets, opened in a browser, so that the look of the tool is
chosen before it is built rather than reworked afterwards. Neither is wired to
anything: the layouts run on fake Projects and Actions, and every control on both
sheets is inert.

They are separate on purpose. A layout that works should not be rejected because
of a Mockup that does not.

| Sheet | Question |
|---|---|
| `layouts.html` | Which arrangement should the UI have? |
| `mockups.html` | Which surrounds should the Mockup presets be? |

Open either by double-clicking it. There is no build step and no server, and
neither sheet makes a single external request.

## layouts.html

Four directions over one set of fake data, switchable by the tabs or by pressing
`1`–`4`. Each carries a note on what it is good at and what it costs.

1. **Rail and stage** — a tree of Projects and Actions, one clip on the stage,
   Parameters pinned right.
2. **Contact sheet** — every Action a playing card; selecting one opens a drawer
   in the grid.
3. **Single column** — one column, every Parameter of every Action always
   visible, no selection and no modes.
4. **Compare bench** — a flat list of Actions, Latest against Previous, with
   Parameters as a tray underneath.

They share one palette deliberately. What is being judged is where things sit,
not how they are coloured.

## mockups.html

Six candidate surrounds around the same Frame. Four are the presets the spec
asked for — **none**, **a browser window**, **a laptop**, **a phone** — and two
are on the sheet to be argued with rather than because anything asked for them:
**rounded**, which is the cheapest thing that is not nothing, and the browser
window split into **light and dark**, because they do not read the same way.
Choosing fewer than six is a valid outcome.

Silhouettes are generic rather than modelled on identifiable hardware, because
Published clips are public.

Two controls matter more than they look:

- **Backdrop** — a surround reads differently on a light README, a dark README
  and a neutral page, and shadows disappear entirely on one of them.
- **Shown at** — every candidate occupies the same total width, so a Mockup that
  looks considered at 1120px can leave the clip inside it unreadable at the GIF
  default of 640px. Judge at both.

"None" carries no shadow, unlike every other candidate. A shadow is a decision a
Mockup makes, and lending one to the undecorated baseline would rig the
comparison the sheet exists to make.

### Getting a real Frame into it

The committed sheet carries a synthetic placeholder. This repository is public
and the `photos` Project renders a real photo library, so no Frame of it is
committed — the same reason publishing is off for that Project (ADR 0007).

```bash
node spikes/prototype-sheets/inline-frame.mjs
```

That takes one Frame out of the newest Run under `runs/photos/scroll-peek`,
inlines it as a data URI, and writes `out/mockups.html` — still one
self-contained file, still no external requests, but not committed. Record
something first if there is nothing there yet:

```bash
pnpm record run photos scroll-peek
```

It also accepts a directory or a file, and `--at <seconds>` to take the Frame
from a different instant of the clip. It finds the newest file rather than
asking the CLI for Latest, so that a spike does not need the workspace built to
locate one MP4.

## The choice

Fill this in before starting anything that depends on it, and say why in a
sentence — the reason is what stops the decision being reopened every time
something is inconvenient to build.

- **Layout direction**: _not chosen yet_
- **Mockup presets to build**: _not chosen yet_
- **Default Mockup for a new Project**: _not chosen yet_

Once all three are recorded and the tickets that depend on them are open, delete
this directory. These sheets are evidence for a decision, not a design system.
