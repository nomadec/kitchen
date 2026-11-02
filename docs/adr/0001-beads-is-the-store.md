---
status: accepted
---

# Beads is the store of record, not a GitHub Project

super-board, the closest product to Kitchen, keeps its work state on a GitHub Project board. Kitchen keeps every order, phase, pass and station in a beads database and treats GitHub Issues, Jira and files as sources it reads and GitHub pull requests as outputs it writes. Beads gives dependencies, atomic claims with leases, gates and an events journal in one store, which a project board does not, and it lets one team space track many repositories.

## Consequences

- A tracker outage never stops the expeditor; only intake and publishing wait.
- Humans who live in a tracker see Kitchen's work only through what it publishes back, so the UI is the primary human surface.
