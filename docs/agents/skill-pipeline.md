# Skill pipeline

Where code sits relative to the thinking skills, and what each stage hands the
next.

| Stage | Skill | What it produces |
|---|---|---|
| Decide | `/grilling`, `/grill-with-docs` | Decisions, and the glossary entries they resolved |
| Specify | `/to-spec` | **One** spec issue, labelled `ready-for-agent` |
| Slice | `/to-tickets` | Tracer-bullet tickets, each declaring its blocking edges natively |
| Build | `/implement`, `/tdd` | One ticket, in a fresh context |

## A thinking session ends at decisions

It writes no code and opens no branch. Reaching the conclusion **is** the
deliverable; turning it into a spec is the next session's job, and turning that
into tickets is the one after.

This is not bureaucracy. A decision reached in a long conversation is worth
exactly as much as the spec it becomes, because the conversation is thrown away
and the spec is not — and a change written in the session that argued for it
arrives with no ticket, no acceptance criteria, and nobody but its author having
read the argument.

## Being told to decide is not being told to build

**"Whatever you think is best" settles a design question.** It hands you the
decision, not a branch. Neither does a decision being obviously correct, nor the
change being small, nor the defect being real and currently shipping.

If the work looks so clearly right that writing it feels like the natural next
step, that is the moment to write the spec instead — the same clarity makes for a
short spec and an unambiguous ticket.

## A spike is a ticket, not a detour

An assumption the plan rests on and nobody has tested becomes a `/prototype`
ticket of its own, and every ticket that depends on the answer is `blocked_by`
it. The answer then arrives in its own session, and closing the spike is what
surfaces the work it unblocked to the frontier query.

The prototype itself is throwaway: captured on a branch out of `main`, with its
verdict and the question it settled recorded on the ticket. Only the validated
decision reaches `main`.

## One ticket, one context

A spec is not carried through a single chat. Each ticket is sized to a fresh
context window and is demoable on its own, which is what makes it safe to hand
the next one to a different session.

## A defect found while thinking is still a defect

File it. Fixing it in the same session is the same mistake wearing a useful
disguise — and a bug found while grilling is usually the best-specified ticket
you will write that day, because the evidence is already in hand.
