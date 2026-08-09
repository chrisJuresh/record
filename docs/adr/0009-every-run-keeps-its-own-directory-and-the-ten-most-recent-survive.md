# Every Run keeps its own directory, and the ten most recent survive

A Run writes into `runs/<project>/<action>/<run>/`, named for the instant it
began, holding its Artifacts, its embed snippet and `run.json` — the record of
what it was produced under. No Run writes over another. **Latest** is simply the
newest directory, and the ten most recent Runs of an Action are kept while older
ones are pruned as each new Run succeeds.

A Run is worth keeping because judging a change means seeing what it replaced:
the previous clip beside the Latest, and the commit, Parameters and tool
versions each was made with. A Run whose Artifacts were written over could only
ever be compared against nothing.

Ten is the cap because a Run is a pile of encoded video. Retention with no limit
is a tool that fills the disk of anyone who leaves it running, and pruning as a
Run succeeds means nobody has to remember to tidy up.

## Consequences

A Run that fails takes its own directory away with it, which is the whole of how
the last good Run's Artifacts survive a failure — there is no partial state to
unwind, because a failing Run never touched anything but its own directory.

`runs/` is excluded from version control (ADR 0003, ADR 0007): Frames can
contain anything the Project renders, and there are now up to ten Runs' worth of
them per Action.

The directory a Run produced is not a stable path — it names the instant, so it
differs every Run. Anything reaching for the Latest asks the tool (`record
status`, `record history`) rather than hard-coding a filename.

Staleness is read from the same record. `record status` compares the Project's
current commit against the commit the most recent Run wrote down, so an Action
that has never run and a Project with no commit to read are each "not that I can
tell" rather than "current".
