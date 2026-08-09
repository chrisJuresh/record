# Overrides live beside Actions, never inside them

An Action declares its Parameters and their defaults in its own TypeScript file.
Values tuned by hand in the UI are written to a separate sidecar file next to it.
The UI never edits the TypeScript.

## Considered Options

- **Writing tuned values back into the Action's source** — keeps everything in one
  file, but means regenerating or refactoring an Action clobbers hand-tuning, and
  a UI that rewrites source code is a UI that eventually corrupts source code.

Splitting them gives each file a single owner: the agent owns the Action and may
rewrite it freely, the person tuning owns the sidecar and may change it freely,
and neither can destroy the other's work. "Reset to default" becomes deleting a
file.

## Consequences

There are two files per tuned Action, and the UI must show which Parameters are
overridden so the effective value is never a mystery. An Override naming a
Parameter that no longer exists is stale data the tool has to report rather than
silently ignore.
