# Record

A tool for producing short, repeatable video and image clips of locally-running
websites, so that a change to a site can be re-shown without re-performing it by
hand.

## Language

### The things being recorded

**Project**:
A website running on this machine that clips are made of.
_Avoid_: site, app, target, source

**Action**:
A named, re-runnable recipe describing one piece of on-screen motion within a
Project — "scroll down a little and back up", "open the lightbox".
_Avoid_: clip, shot, take, scene, animation, recipe

**Timeline**:
The ordered motion an Action performs, expressed as a sequence of movements and
holds with declared durations.
_Avoid_: script, steps, sequence, storyboard

**Hold**:
A span of Timeline during which nothing moves. Used at the start and end of an
Action so a looping clip pauses instead of snapping back.
_Avoid_: pause, freeze, dwell, delay

### The things produced

**Run**:
One execution of an Action, together with what it produced and the conditions it
was produced under.
_Avoid_: render, job, capture, recording, build

**Frame**:
A single captured image of the page. A Run captures many Frames and encodes them
into Artifacts.
_Avoid_: still, shot, screenshot

**Artifact**:
A finished file produced by a Run — an MP4, a WebM, or a GIF.
_Avoid_: output, clip, asset, video, media

**Embed snippet**:
The video element a Run writes beside its Artifacts, naming both video sources,
so that putting a clip on a page never requires remembering the element's
attributes. Not itself an Artifact — nothing is encoded into it.
_Avoid_: embed code, HTML snippet, player, markup

**Run history**:
The Runs of an Action still kept on this machine — the ten most recent, each
with what it produced and the conditions it was produced under. Older Runs are
pruned as newer ones succeed.
_Avoid_: archive, log, past runs, versions

**Latest**:
The Artifacts of the most recent successful Run of an Action, which is the
newest Run in its history. What the UI shows and what Publishing copies.
_Avoid_: current, head, newest

### Tuning and appearance

**Parameter**:
A named, tunable value an Action declares — a distance, a duration, an easing, a
framerate — with a default and a sensible range. Never called a setting: a
Setting is a Project's, and the two have different owners and different files.
_Avoid_: option, setting, config, knob, prop

**Setting**:
A named value a Project is configured with — where it answers, how it is
started, what it is photographed at, whether it is Published. Written in the
Project's `project.toml` and owned by whoever configures the Project, where a
Parameter is declared by whoever writes an Action. A Setting the Project's file
does not say is one the tool stands its own value in for.
_Avoid_: option, preference, field, property, parameter

**Override**:
A Parameter value chosen by hand that replaces the Action's declared default.
Overrides are owned by the person tuning; declared defaults are owned by whoever
wrote the Action.
_Avoid_: custom value, tweak, patch, adjustment

**Mockup**:
The decorative surround composited around the captured Frames — a browser
window, a laptop, a phone. Deliberately not called a "frame", because a Frame is
a single captured image.
_Avoid_: frame, chrome, bezel, device, skin, shell

**Aperture**:
The opening in a Mockup that the Frames are composited into. A Mockup declares
where its Aperture is by putting an element there; where that lands is measured
rather than agreed in advance.
_Avoid_: hole, screen, window, cutout, slot

**Backdrop**:
The colour a Mockup is composited onto, filling everything its template leaves
transparent — the page a surround is drawn to sit on, and the thing its shadow
falls on.
_Avoid_: background, canvas, page, matte

**Cursor style**:
The appearance and behaviour of the synthetic pointer drawn into an Action —
its shape, its click feedback, whether keystrokes are captioned. No real mouse
pointer ever appears in a Frame, so every cursor is drawn.
_Avoid_: mouse, pointer skin, cursor theme

**Text override**:
Replacement copy substituted into the page before capture, so a clip can show
wording that differs from what the running site displays.
_Avoid_: mask, redaction, stub, fixture

### Execution and distribution

**Deterministic capture**:
Capture in which the Artifacts depend only on the declared Timeline and never on
how fast the machine happened to be running. Two Runs of an unchanged Action and
an unchanged Project produce the same Frames.
_Avoid_: reproducible capture, frame-accurate capture

**Matrix**:
A set of Runs of a single Action across varied conditions — light and dark, or
several viewport widths — produced by one request.
_Avoid_: variants, sweep, permutations, batch

**Condition**:
One set of circumstances within a Matrix that an Action is recorded under — a
colour scheme, a viewport width, or both. A Condition varies how the page is
photographed and never what the Action does. Each has a Latest and a Run history
of its own, and names the Artifacts it produced.
_Avoid_: variant, case, combination, axis

**Theme hook**:
The pair of expressions a Project declares for putting its own page into light
and into dark, for a site whose theme is a class or a stored preference rather
than the reader's system setting. Used in preference to emulating the media
query, never alongside it.
_Avoid_: theme switcher, toggle, adapter, driver

**Progress**:
What a Run says about itself while it is still running — the stage it has
reached, and how many of its Frames it has captured. Watched as it happens and
never stored: a Run's record says what it produced, not what it was up to, and
nothing it produces depends on whether anybody was watching.
_Avoid_: status, state, update, event, tick

**Stale**:
The state of an Action whose most recent Run predates commits made to its
Project since. Staleness is reported, never acted on automatically.
_Avoid_: dirty, outdated, invalidated, expired

**Published**:
The state of a Project whose Latest Artifacts are committed into this repository's
public folder, and are therefore linkable from anywhere. The opposite state
leaves Artifacts on this machine only.
_Avoid_: exported, deployed, shared, released
