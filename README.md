# Kitchen

A runtime for agentic delivery on top of [beads](https://github.com/steveyegge/beads). One shared work graph, phases and stations registered into it on demand, one expeditor per host that starts fresh agent sessions, and a pass where a human decides. Kitchen holds no recipe of its own; the first recipe registered into it is Umka.

Vocabulary is in `GLOSSARY.md`. Decisions are in `docs/adr/`.

## Primitives

Each line names a Kitchen primitive and the beads feature under it. The glossary defines the Kitchen word; this list is where the mapping lives.

| Kitchen | beads | Used in v1 |
| --- | --- | --- |
| Space | One Dolt database behind `bd` server mode, one SQL user per person | yes |
| Order | An epic bead with a source reference, a repository note and a class | yes |
| Phase, registered | A bead of custom type `phase` holding the phase file | yes |
| Revision | A `rev:<revision>` label on the registered phase beads, named in the order's `recipe:` note | yes |
| Phase, laid | A child task bead of the order, assigned to a station, blocked by what must finish first | yes |
| Station | A bead of custom type `station` holding the launch spec | yes |
| Source | A bead of custom type `source` holding the cursor | yes |
| Ready work | `bd ready` | yes |
| Claim | `bd update --claim`, atomic in the SQL server | yes |
| Lease | `bd heartbeat` while the session lives, `bd reclaim` when it dies | yes |
| Pass | A gate bead of type `human` | yes |
| External wait | Gate beads of type `timer`, `gh:pr`, `gh:run`, `bead`, evaluated by `bd gate check` | yes |
| Dependency | `bd dep`, blocking edges between laid phases | yes |
| Actor | `--actor` on every write, in the audit trail | yes |
| Activity | The events journal, `bd events` | yes |
| Operational state | `bd set-state`, an event plus a label | later |
| Worktree | `bd worktree` or Kitchen's own, one per order | yes |
| Merge serialisation | `bd merge-slot` | later |
| Formula, molecule | `bd formula`, `bd mol`: static work templates, not used because recipes route in prose | known, not exposed |
| Swarm | `bd swarm`: structured parallel work on an epic | known, not exposed |
| Federation | `bd federation`: peer workspaces | known, not exposed |
| Memory | `bd remember`, `bd recall` | known, not exposed |
