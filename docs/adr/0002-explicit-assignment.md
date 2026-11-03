---
status: accepted
---

# Work reaches a station by explicit assignment, chosen by the turn that lays it

A phase is for a station when the bead's assignee is that station's name. The turn that lays a phase chooses the station: it reads what the phase needs, in prose, against what each registered station advertises, writes the station's name as the assignee, and notes why. No component matches work to stations on its own, and no table binds phases to stations ahead of time. Explicit assignment is readable in `bd show` and in the audit log, and the choice is made by the one party that holds the context of the moment.

## Considered options

- Capability matching in the expeditor: the expeditor picks any station whose labels cover the phase. Rejected because a wrong pick is silent and the expeditor stays a dispatcher, not a judge.
- A role binding table: a phase names a role and a table maps roles to stations. Rejected because it adds a concept that the laying turn's judgment already covers.
