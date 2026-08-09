# Actions are TypeScript timelines, not declarative documents

An Action is a TypeScript module that describes its Timeline by calling a small
set of motion primitives, with the raw browser page available as an escape hatch.
It is not a YAML or JSON document, and it is not produced by recording a human
using the site.

## Considered Options

- **Declarative YAML steps** — reads beautifully for the first few Actions, then
  hits a wall at the first conditional or loop, at which point the format grows an
  expression language and becomes a worse programming language than the one
  already available.
- **Record-and-replay from real mouse input** — captures wall-clock human movement,
  which is jittery and fundamentally incompatible with a stepped virtual clock
  (see ADR 0001).

Actions are written by an agent rather than hand-authored, so the usual argument
for a declarative format — that it is approachable to non-programmers — does not
apply here. Types, by contrast, catch a wrong option name instantly instead of
after a ten-second render.

## Consequences

Every Action is executable code from this repository, so the tool trusts its own
Action files completely. Nothing else may be executed as an Action.
