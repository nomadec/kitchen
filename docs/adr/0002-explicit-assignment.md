---
status: accepted
---

# Work reaches a station by explicit assignment

A phase is for a station when the bead's assignee is that station's name. The router at intake sets the first assignee; a station that needs another station assigns a phase to it by name. Capability labels on stations exist for humans and the router to search, and no component matches work to stations by capability on its own. Explicit assignment is readable in `bd show` and in the audit log, and with a handful of stations there is nothing for matching to decide.

## Considered options

- Capability matching: the expeditor picks any station whose labels cover the phase. Rejected for v1 because a wrong pick is silent, and because it is easy to add later on top of the explicit model.
