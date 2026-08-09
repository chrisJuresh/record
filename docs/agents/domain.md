# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary.
- **`docs/adr/`** — read the ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-deterministic-frame-stepping-is-the-only-capture-engine.md
│   └── ...
└── packages/, apps/
```

A `CONTEXT-MAP.md` at the root would mean the repo had split into multiple contexts. It has not. Note that this repo *will* become a pnpm workspace with several packages — that alone is not a reason to split contexts. Split only when packages stop sharing one vocabulary.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

Two that are easy to get wrong here: a **Frame** is a single captured image, while a **Mockup** is the decorative surround composited around it — never call a Mockup a "frame". And an **Action** is the re-runnable recipe, while a **Run** is one execution of it.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (publishing pushes this repository and nothing else) — but worth reopening because…_
