# Kitchen

A runtime for agentic delivery on top of [beads](https://github.com/steveyegge/beads). One shared work graph, phases and stations registered into it on demand, one expeditor per host that starts fresh agent sessions, and a pass where a human decides. Kitchen holds no recipe of its own; the first recipe registered into it is Umka.

Vocabulary is in `GLOSSARY.md`. Decisions are in `docs/adr/`.

## Install

Kitchen is the npm package `@nomadec/kitchen`, providing the `kitchen` command. It needs Node 24 and `bd` (beads 1.3.1) on the path.

```sh
npm install -g @nomadec/kitchen
kitchen --help
```

From a clone:

```sh
npm install
npm run build        # compiles src/ to dist/
npm test             # node:test against a fake command runner; no bd or claude needed
npm run typecheck
node dist/bin/kitchen.js --help
```

Every external process Kitchen runs goes through one command runner (argv in; stdout, stderr and exit code out) and every read of the time through one clock. Tests inject a fake runner scripted from a table that records every call, plus a fake clock; both are exported from `@nomadec/kitchen/testing`.

## `kitchen init`

A new host is ready in one step. `kitchen init` writes the host config and verifies the connection to the space:

```sh
kitchen init --server rbn3:3307 --owner sona
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--server <host:port>` | The Dolt SQL server the space lives on | required |
| `--owner <name>` | The person this host belongs to; the human actor on every write | required |
| `--database <name>` | The space's database on that server | `kitchen` |
| `--user <name>` | The SQL user; one per person, shared with that person's stations | the owner |
| `--credential <file>` | The beads credentials file whose `[host:port]` section holds the password | `~/.config/beads/credentials` |
| `--host <name>` | This host's name, as stations registered here carry it | the hostname |

The config lands in `$XDG_CONFIG_HOME/kitchen/config.json` (`~/.config/kitchen/config.json` by default) and holds the server, the credential reference, the owner and the host. No secret is written: the password stays in the beads credentials file the reference names. Next to it, `kitchen init` creates the beads workspace under `~/.config/kitchen/space` that every later `bd` command runs from, by running `bd init --server --external` against the configured server under the owner's actor. That call is the verification: when the server cannot be reached, `kitchen init` prints the command's stderr, exits non-zero and writes no config. Running `kitchen init` again re-initialises the existing workspace in place (local metadata only; the server's data is untouched) and a failed run never removes a workspace or a config that was already there.

## The phase graph

The design illustration is drawn from the space, not by hand. The generated file is `docs/phase-graph.md`: a Mermaid graph of the registered phases of every recipe's latest revision (pass phases, entry phases with their classes, `per:` fan-outs and cross-recipe edges) and the paths a reader can derive from each entry phase, each stopping where it returns to a phase already walked. It is committed with the first registration and regenerated after every `kitchen recipe add`, from a host that has run `kitchen init`:

```sh
node scripts/phase-graph.ts > docs/phase-graph.md
```

The script is not a CLI command; it reads the space with `bd list` and `bd show` under the owner's actor and writes nothing to it.

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
| Actor | `--actor` on every write, in the audit trail; the rules are cooperative, see `docs/trust-model.md` | yes |
| Activity | The events journal, `bd events` | yes |
| Operational state | `bd set-state`, an event plus a label | later |
| Worktree | `bd worktree` or Kitchen's own, one per order | yes |
| Merge serialisation | `bd merge-slot` | later |
| Formula, molecule | `bd formula`, `bd mol`: static work templates, not used because recipes route in prose | known, not exposed |
| Swarm | `bd swarm`: structured parallel work on an epic | known, not exposed |
| Federation | `bd federation`: peer workspaces | known, not exposed |
| Memory | `bd remember`, `bd recall` | known, not exposed |
