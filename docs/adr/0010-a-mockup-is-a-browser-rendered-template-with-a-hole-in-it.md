# A Mockup is a browser-rendered template with a hole in it

A Mockup is an HTML/CSS document, rendered once per Run by the same
`chrome-headless-shell` that captured the Frames, into a transparent image with
an aperture where the screen goes. The Frames are composited into that aperture
by ffmpeg, on the way to the Artifacts.

Two rejected alternatives explain the shape of it.

**Drawing the surround into the page**, as the cursor overlay is drawn, would
put it inside the Frames — where the page can scroll underneath it, where a
Project's own stylesheet is one `!important` away from it, and where it would be
captured at the viewport's size rather than around it.

**Drawing the surround in code**, with an image library, would make adding a
Mockup a programming task against an API nobody can see the result of. Every
image dependency this repository could take on is also a second renderer to keep
agreeing with the first.

A template therefore declares nothing about geometry. It marks one element
`data-record-aperture` and fills everything around it — a spread `box-shadow`
rather than a background, so the aperture is a hole rather than a rectangle
painted over. Where that hole ends up is **measured off the laid-out document**,
so what a template has to get right is what it looks like.

## Consequences

Adding a Mockup is adding an entry to the registry in
`packages/core/src/mockup.ts`. Nothing outside it names a template: one browser
render, one measurement and one filter graph serve every preset, and
`record mockups <project> <action>` renders every one of them around a real
Frame to show it.

A surround is filled with its own declared backdrop at composite time rather
than in the template, because the Artifacts have to be opaque — a colour ffmpeg
lays down under everything the template left transparent, including under the
shadow the surround casts.

Compositing is bit-exact like the rest of encoding, and the render is a
photograph of a static document, so two Runs of an unchanged Action inside an
unchanged Mockup are still the same bytes. The cost is a second browser launch
per Run — small beside the capture it follows, and only paid by a Run that
composites something.
