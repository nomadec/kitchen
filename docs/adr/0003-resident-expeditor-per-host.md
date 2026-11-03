---
status: accepted
---

# One resident expeditor per host, instead of timers

Umka ran its tick and inbox as launchd and systemd timers every ten seconds, serially, with one shared home. Kitchen runs one long-lived expeditor process per host, which polls the space for phases assigned to the stations registered on that host, starts them in parallel across orders up to each station's cap, heartbeats their leases, evaluates typed gates, serves the UI and exposes `bd serve`. A resident process can hold leases, track child processes and enforce wall-clock budgets, which a timer-started script cannot do without a journal on disk.

## Consequences

- The expeditor is itself installed as a user service, so the timers are not gone, just reduced to one.
- Each host only runs stations owned by the person logged in there; a team member's agents never run on another member's machine.
- Prior art: Gas City's claim, heartbeat and reclaim protocol, and its worktree per bead with scoped teardown.
