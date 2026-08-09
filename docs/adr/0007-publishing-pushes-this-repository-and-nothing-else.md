# Publishing pushes this repository and nothing else

This repository is public. Artifacts for Published Projects are committed here and
linked from elsewhere by URL. The publish action commits and pushes this
repository only; it never writes to, commits to, or pushes any Project's own
repository.

## Considered Options

- **Committing each clip into the repository of the Project it shows** — puts the
  media next to the thing it documents, but to commit one file the tool must
  either sweep up whatever else is uncommitted in that repository or implement
  partial staging. Both eventually commit the wrong thing on the wrong branch, and
  that is an unacceptable failure mode for a button pressed without thinking.

Keeping every clip here also means one public media location serves every Project,
including private ones.

## Consequences

Publishing is the only irreversible, outward-facing operation in the tool, and the
only way something private could become public. It therefore always shows exactly
what is about to be pushed — files, sizes, and which Projects are included — and
waits for confirmation.

Publishing is **off by default for every Project**, and a Project that is not
Published keeps its Artifacts on this machine only. Run history is likewise never
committed: it exists on this machine to support comparing a Run against the one
before it, and is pruned rather than preserved.
