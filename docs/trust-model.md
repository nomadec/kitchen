# The trust model: cooperative, not enforced

Kitchen keeps people and their agents apart in the audit trail, not with a lock. This page says what that buys and where it stops, as story 33 of the spec asks.

## Who writes as whom

Every write to the space carries an actor, passed as `--actor` on the `bd` command Kitchen builds:

| Who | Actor | Example |
| --- | --- | --- |
| A person at a CLI or in the UI | `<owner>` | `sona` |
| A turn at a station | `<owner>/<station>`, the station's title | `sona/grill` |
| The expeditor on a host | `<owner>/expeditor` | `sona/expeditor` |

Beads records the actor as provenance on every mutation and in the events journal, so the history of an order reads as people and their agents. A session the runner starts carries its station in `BEADS_ACTOR`; a person at a CLI carries nothing and writes as the owner named in the host config. The one place the expeditor does not write as `<owner>/expeditor` is what beads requires from the holder: the take on an order, the claim and the heartbeat of a phase, and the release of the take at the turn's end (another actor's update of a held bead is refused without `--force`). It opens the space under the station's actor for those, so the claim assigns the station itself.

## The cooperative rules

Kitchen's `bd` wrapper, the CLI and the UI refuse these writes before any `bd` write is issued:

- under a station actor, creating or editing a bead of type `phase`, `station` or `source`: registering recipes, stations and sources is a human act (glossary: Registration). The expeditor is not a station and keeps a source's cursor on the source bead, so this rule does not bind it;
- under a station or the expeditor, closing a pass, a gate bead of type `human`: a pass closes only under a person's name (glossary: Pass, Actor). When the caller has not read the gate's type, the wrapper reads it first.

A turn may still lay a pass, label it `briefed` or `applied`, lay and close its own phases, add dependencies and write notes. The turn driver never closes a pass. The refusal names the rule and points here.

What the rules protect against is an agent drifting into registration, or answering a pass for its owner, by accident while following a skill. That is the whole promise.

## Where it stops

Every person and their stations share that person's one SQL credential, on that person's own host, and beads treats the actor as provenance, not as authenticated identity. So:

- a station that runs `bd` directly, calls `bd serve` over HTTP, or opens the database, is not stopped;
- a station that passes `--actor <owner>` itself is recorded as the owner, and nothing in Kitchen, beads or the server can tell the difference;
- a hostile agent is outside what v1 protects against. A station runs with its owner's own trust on its owner's own host, and no component of Kitchen claims that a station is technically unable to act as its owner.

An enforced boundary between a station and its owner is out of scope for v1 (spec: Out of Scope). ADR 0003 records the decision; `docs/qa/issue-1-spec-review.md`, section 7, is the checklist that verifies the rules above hold through Kitchen's own surfaces and that no stronger claim is made.
