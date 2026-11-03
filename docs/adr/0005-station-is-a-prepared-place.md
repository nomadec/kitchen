---
status: accepted
---

# A station is a prepared place, not an agent type

Two readings of "station" were on the table. An agent type, such as griller, builder or reviewer, or a prepared place, such as a host with the right repositories, tooling, models and presence. Umka's earlier Slack host had agent types named Dispatcher, Builder, Reviewer, Debugger and Bouncer and dropped them when the `run` skill moved the skill onto the phase. A station as an agent type would duplicate what the phase already says.

Kitchen takes the second reading, in the sense of a kitchen station: a place set up so a cook can start at once. A station is a host, the repositories checked out there, the plugins and tooling present, the models it can launch, its concurrency cap and budget, and whether a human sits there. The phase says what is done and with which skill and model. The order says which repositories. The turn that lays a phase reads those against what each station offers and assigns the station by name.

Worktrees keep their value inside a station: the station provides the checkouts, and each order gets its own worktree in them, so two orders at one station never collide.

## Consequences

- A team of two needs about three stations: an unattended one, an attended one, and one for a stack that only some hosts have.
- A phase that no registered station can serve, for example a cross-repository order with no station holding every checkout, ends in a pass that names the gap.
- Prior art: poteto's pstack framing, in which cooks lack context and a prepared station.

## Considered options

- Agent types with roles bound per order: rejected because the skill is already on the phase and a binding table adds a concept the laying turn's judgment covers.
