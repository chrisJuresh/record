# record

A tool for producing short, repeatable video and image clips of locally-running
websites. Read [CONTEXT.md](./CONTEXT.md) for the vocabulary before writing
anything that names a domain concept.

## Layout

A pnpm workspace of TypeScript packages, built with project references.

- `packages/core/` — Timeline evaluation, Project configuration, and the capture
  engine once it lands.
- `packages/fixture-site/` — the static site every test records against, and the
  harness that serves it on an ephemeral port.
- `apps/cli/` — the `record` command. **The CLI is the real interface**: the
  server and the UI will reach the tool through these commands rather than
  around them, so a new operation is a command first.
- `projects/<name>/project.toml` — one configured Project. Actions live beside
  it under `actions/`. Nothing is ever written into a Project's own repository
  (ADR 0003).
- `spikes/` — throwaway evidence behind an ADR. Not the engine; nothing imports
  it.

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

`record` reads its Projects from `$RECORD_WORKSPACE`, defaulting to this
checkout. Tests set it to a workspace of their own — **no test may depend on a
real Project being present, and none may read the photo vault.**

## Testing

There are exactly two seams, and tests live only at them:

- **The CLI seam** (`apps/cli/test/`) — almost all behaviour, asserted by
  running the built command and reading its `--json` output.
- **The Timeline evaluation seam** (`packages/core/test/`) — easings, Hold
  boundaries, duration rounding and Override application, with no browser
  involved.

`packages/fixture-site/test/` is the one exception, and it tests the harness
rather than the tool: a fixture site that quietly stopped serving would weaken
every assertion made against it, determinism most of all.

Assert on what is observable from outside: the files a Run produced, the plan a
publish would carry out. A test that reaches into an intermediate structure the
operator cannot see will be rejected in review.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `chrisJuresh/record`, driven through the
`gh` CLI. Blocking is expressed with GitHub's native issue dependencies, not only
as prose. See `docs/agents/issue-tracker.md`.

**Every issue resolved by a code change lands through a pull request** — a
branch named `<issue-number>-<slug>`, a PR opened at the first push whose body
says `Closes #<number>`, and a merge that closes the issue. Nothing is committed
to `main` directly, and no agent merges or closes on its own.

### Triage labels

The five canonical triage roles, each label string equal to its name, plus a
`bug`/`enhancement` category role on every triaged issue. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
