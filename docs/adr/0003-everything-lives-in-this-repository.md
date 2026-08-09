# Everything lives in this repository

Actions, Parameter overrides, Project configuration, and Published Artifacts all
live here. Nothing is written into the repository of the Project being recorded.

## Considered Options

- **Per-project `.record/` directories** — an Action would sit next to the code it
  targets, so renaming a selector and breaking an Action would show up in the same
  diff. Rejected because it scatters the tooling across every repository and makes
  adding a clip require a commit to the project.

The deciding factor is that Actions are commissioned from a conversational session
that may be running anywhere on the machine. One known location is easier to find
and far safer than mutating whichever repository happens to be open.

## Consequences

An Action can silently rot when its Project changes, because nothing in the
Project's own history references it. Staleness reporting exists to partially
compensate: a Project with commits newer than an Action's last Run is flagged,
which catches drift without pretending to detect breakage.
