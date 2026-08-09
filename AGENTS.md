# record

A tool for producing short, repeatable video and image clips of locally-running
websites. Read [CONTEXT.md](./CONTEXT.md) for the vocabulary before writing
anything that names a domain concept.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `chrisJuresh/record`, driven through the
`gh` CLI. Blocking is expressed with GitHub's native issue dependencies, not only
as prose. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name, plus a
`bug`/`enhancement` category role on every triaged issue. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
