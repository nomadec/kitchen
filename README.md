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

## `kitchen station add` and `kitchen source add`

Registration is a human act: both commands run under the owner's bare actor and are refused, before any `bd` call, in a session whose actor is a station. `kitchen station add <template>` registers a station from a `station.json` template (a file, or a plugin directory holding one) plus the values only this host knows: the local path of each repository, the cap, the wall-clock timeout, secret names, and `--attended` when a human sits there. `kitchen source add` registers a polled source with its kind (`github` or `file`), target, recipe and class, polled by this host unless `--host` names another. `docs/registration.md` shows the example template, the beads both commands create and the reader that parses them back.

## `kitchen order add`

`kitchen order add <source> --recipe <name> [--class <class>] [--repo <slug>...]` takes a GitHub issue URL, a file path or free text and makes it an order: an epic bead with the `loop` label, the source as its external reference, a `repos:` note of remote slugs, a `recipe:` note naming the recipe and the revision it pins (the latest at intake) and a `class:` note. A source that is an order already (by external reference, then by its substring) is printed and nothing is created. The class comes from `--class`, else from the source: an issue labelled `bug` is a bug, `ready-for-agent` a spec, any other issue a ticket; a file or free text is an idea. Intake then lays the recipe's entry phase for the class and assigns it mechanically to one of your stations, or lays a pass titled `no station for <phase>` naming the gap. `docs/intake.md` shows the beads, the choice of station and the intake function the expeditor's source poll reuses.

## `kitchen up` and `kitchen down`

`kitchen up` installs this host's expeditor as a user service and starts it: a systemd user unit at `~/.config/systemd/user/kitchen-expeditor.service` on Linux, a launchd agent at `~/Library/LaunchAgents/ai.nomadec.kitchen.expeditor.plist` on macOS. The unit runs `kitchen up --foreground --interval <seconds>` (default 5), the long-lived process itself; `kitchen up --foreground --once` runs one tick in the terminal and waits for the turns it started, for a check by hand. `kitchen down` stops the service and removes the unit; the claims its turns hold are left as they are, so their leases go stale and a later tick reclaims them.

Each tick is a sequence of named steps, in the order the spec lays them: `config`, `stations`, `gates`, `passes`, `sources`, `leases`, `reclaim`, `worktrees`, `ready`, `orders`, `caps`, `attended`, `dispatch`. Five in the middle (`bd gate check`, the word on Kitchen-laid passes, the source poll, the lease heartbeats and the reclaim) are named in their place and logged as skipped until their slices land. What runs today: the stations whose owner and host match the config are read; the worktrees of closed orders under this host's checkouts are removed (see below); `bd ready` is listed per station assignee; a phase whose order is taken by a turn (a `loop` epic in progress and assigned to a station, on any host) is dropped; a station at its `cap:` is dropped; a phase on an attended station is labelled `waiting` and listed with the `kitchen turn <phase>` command that starts it; every remaining phase on an unattended station is started: the order is taken (`bd update <order> --claim` under the station actor, the per-order limit held in the space), its worktrees are created or reused, the phase is claimed the same way, and the runner is spawned. At the turn's end the last line of the session's output is commented on the phase bead and the order is released.

The v1 runner spawns `claude` with the Kitchen plugin directory and the plugins the station lists, the prompt that invokes the `kitchen:turn` skill with the phase id, the order's worktree in the station's checkout of the first repository the order names as the working directory (that checkout itself when the phase touches no code), `BEADS_ACTOR`, `BEADS_DIR` and `BEADS_CREDENTIALS_FILE` in the environment, and the model and effort from the phase; a headless turn adds `--print`, `--max-budget-usd` from the phase's `budget.usd` and runs with permission prompts skipped, since no one is there to answer them. The expeditor writes as `<owner>/expeditor` except the take, the claim and the release, which beads requires from the holder (another actor's `bd update` of a held bead is refused without `--force`) and which it writes as the station. Its log is `$XDG_STATE_HOME/kitchen/expeditor.jsonl` (`~/.local/state/kitchen/expeditor.jsonl` by default): one JSON object per step per tick, each with the tick number, the step and what it read, dropped or started.

### Worktrees

A phase touches code when its order names repositories. Under the `per-order` worktree policy, each repository the order names and the station offers gets one worktree, `<station checkout>/.kitchen/worktrees/<order>` on branch `kitchen/<order>`, between the take and the claim. Creation fetches `origin` and checks out the remote `kitchen/<order>` branch when another host's turn pushed one, so a handoff continues from the same commits; else it branches from the checkout's upstream (`@{upstream}`, or `HEAD` when the checkout tracks nothing). A worktree that exists already is reused, with the remote branch fast-forwarded in when there is one, so a handoff back to this host also continues from the pushed commits. A git call that fails (no network, a worktree whose branch diverged from the pushed one) releases the take and drops the phase with git's message in the log, every tick until someone puts it right.

At creation the worktree's own config (`git config --worktree`, so the main checkout's identity is untouched) gets the owner as `user.name`, the station title as `kitchen.station`, and `core.hooksPath` pointing at `<station checkout>/.kitchen/hooks`, where Kitchen writes a `prepare-commit-msg` hook that adds a `Kitchen-Station: <station title>` trailer to every commit message. Commits made in a turn therefore carry the owner as author (the author e-mail is the checkout's own, the owner's on the owner's host) and the trailer naming the station. Kitchen's hook runs the repository's own `prepare-commit-msg` under `.git/hooks` first, so what beads or the project installed there keeps running; the other hooks of the repository do not run inside the worktree.

Every tick, before `bd ready` is read, the expeditor lists the worktree directories under each checkout of its stations, reads each order once, removes the worktrees of closed orders (`git worktree remove --force`, then `git branch -D kitchen/<order>`; the remote branch is the closing turn's to delete) and keeps the rest, logging both lists. Cleanup runs on this host's own clock, so an order closed while the host was off is removed on its first tick back. The `.kitchen` directory is untracked in the station checkout; ignore it in `.git/info/exclude` if `git status` there should stay clean.

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
| Worktree | Kitchen's own `git worktree` per order per repository, under `<checkout>/.kitchen/worktrees/<order>` | yes |
| Merge serialisation | `bd merge-slot` | later |
| Formula, molecule | `bd formula`, `bd mol`: static work templates, not used because recipes route in prose | known, not exposed |
| Swarm | `bd swarm`: structured parallel work on an epic | known, not exposed |
| Federation | `bd federation`: peer workspaces | known, not exposed |
| Memory | `bd remember`, `bd recall` | known, not exposed |
