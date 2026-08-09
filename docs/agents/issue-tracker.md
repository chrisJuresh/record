# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on `chrisJuresh/record`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>`. Write multi-line bodies to a file rather than inlining them.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."` — only for issues resolved
  without a code change. An issue resolved by code is closed by merging its pull
  request (see below), never by hand.

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

The remote is HTTPS, not SSH: SSH authentication to GitHub fails on this machine, and `gh` is configured as the git credential helper. Don't switch `origin` back to `git@github.com:` without fixing the key first.

## Blocking relationships

Blocking is expressed with GitHub's **native issue dependencies**, which are visible in the UI — not only as prose in the body.

- **Add an edge**: `gh api --method POST repos/chrisJuresh/record/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker-db-id>`
- `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/chrisJuresh/record/issues/<n> --jq .id`) — *not* its `#number` and *not* its `node_id`. Passing the id as a string fails with `Invalid request`; `-F` sends it typed, `-f` does not.
- **Read**: `issue_dependencies_summary.blocked_by` counts open blockers only, so it is the live gate.

Tickets also carry a `## Blocked by` section in the body listing the same edges, for readers looking at raw markdown.

## Every resolved issue goes through a pull request

**Nothing is committed to `main` directly.** Every issue resolved by a code
change gets a branch and a pull request, and the merge is what closes the issue.
This holds for one-line fixes as much as for features: the PR is where the diff
is reviewed and where the record of why it landed lives.

- **Branch**: one per issue, named `<issue-number>-<slug>` — `2-workspace-cli-and-project-config`.
  Branch from up-to-date `main`.
- **Open the PR** as soon as the first commit is pushed, not when the work is
  finished: `gh pr create --title "..." --body-file <file>`. Same body-file rule
  as issues — write multi-line bodies to a file, BOM-free (see below).
- **Link the issue** from the PR body with a closing keyword on its own line —
  `Closes #<number>` — so merging closes the issue and GitHub records the link.
  One issue per PR; if a branch resolves several, list a `Closes` line for each.
- **Read a PR**: `gh pr view <number> --comments`, `gh pr diff <number>`.
- **Merging is the human's call.** Agents open, push to, and update PRs, and
  answer review comments on them; they don't merge, and they don't close the
  issue behind the PR's back.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: as above — native issue dependencies. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with `issue_dependencies_summary.blocked_by > 0` or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer to the map's Decisions-so-far.

## Writing issue and PR bodies from PowerShell

Windows PowerShell's `Set-Content -Encoding utf8` writes a UTF-8 **BOM**, which lands at the top of the issue body and can stop a leading markdown heading from rendering. Write body files with `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))` instead.
