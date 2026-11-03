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

Each tick is a sequence of named steps, in the order the spec lays them: `config`, `stations`, `gates`, `passes`, `sources`, `leases`, `reclaim`, `worktrees`, `ready`, `orders`, `caps`, `attended`, `dispatch`. What runs today: the stations whose owner and host match the config are read; the sources whose owner and host match are polled since the cursor on each bead, a `github` source for the issues of its repository updated since then (through `gh issue list`), a `file` source for the lines of a JSON Lines file after a line offset, and each new item becomes an order through intake with the source's recipe and class, the cursor advanced on the bead after each order (so an interruption between the two re-lists the item and the duplicate check, not a second order, answers it; `docs/intake.md`); the typed gates are evaluated (`gates`) and the word on closed Kitchen-laid passes applied (`passes`), both below; the turns whose children live are listed (`leases`); the stale leases in the space are reclaimed (`bd reclaim`) and, since reclaim clears the assignee, each reclaimed phase is assigned again to the station its `station:` label names, so it returns to the station it was laid for (a reclaimed order has no such label and stays released); the worktrees of closed orders under this host's checkouts are removed (see below); `bd ready` is listed per station assignee; a phase whose order is taken by a turn (a `loop` epic in progress and assigned to a station, on any host) is dropped; a station at its `cap:` is dropped; a phase on an attended station is labelled `waiting` and listed with the `kitchen turn <phase>` command that starts it; every remaining phase on an unattended station is started: the order is taken (`bd update <order> --claim` under the station actor, the per-order limit held in the space), its worktrees are created or reused, the phase is claimed the same way, and the runner is spawned. At the turn's end the last line of the session's output is commented on the phase bead and the order is released.

While a turn's child lives, the expeditor heartbeats the phase's lease and the order's take (`bd heartbeat`, as the station, the holder) once a minute, well under bd's five-minute lease; a heartbeat bd refuses (the lease reclaimed, or the bead closed under the turn) ends the heartbeats with the refusal in the log. The station's wall-clock `timeout` kills a child that outlives it, and the kill is logged. When the child exits the phase is read back: closed, the turn is done. Left open, the phase is reclaimed: the station releases its claim (the same write as the take's release) and the expeditor assigns the phase again to the station its `station:` label names, as the tick's reclaim step does. A non-zero exit, a budget overrun the harness reports (`Budget limit reached` on its standard error) or the kill is a failure: `failed:<n>` counts it in that same restore; at `failed:2` a pass titled `turn failed: <phase slug>` is laid for the owner, as a child of the order, blocking the phase, and no further turn is started on it (a phase `bd ready` lists with `failed:2` anyway is dropped). The order is released on every path. The `turn` line of the log carries the exit code, the result line, the outcome (`closed`, `reclaimed`, `failed`), the failure and its count, and the pass.

### Typed gates and the word on a Kitchen-laid pass

An external wait is a gate bead of type `timer`, `gh:pr`, `gh:run` or `bead`, laid by a turn in front of the phase that follows it. Each tick runs `bd gate check`, which evaluates them itself (`gh pr view` for a merged PR, `gh run view` for a green workflow, the clock for a timer, the target's status for a bead gate) and closes the resolved ones; the phase behind a closed gate is in `bd ready` from the next tick and starts like any other, so no session is spent on the wait. The `gates` line of the log carries the counts bd printed and the ids it resolved, or `none open`.

A pass a recipe lays carries an Apply section, and the turn behind it applies the word (the pass's close reason). The three passes Kitchen itself lays, `no station for <phase>` at intake, `rounds reached: <phase>` by the turn driver and `turn failed: <phase>` at the second failure, carry none, so the `passes` step applies their word on the tick after the pass closes: the owner's closed gates not labelled `applied` are listed (`bd list --type gate --assignee <owner> --status closed --exclude-label applied`: a pass is laid for its owner, a typed gate for no one), a recipe's pass is passed over, and for each Kitchen-laid pass the beads it blocks are read (`bd dep list <pass> --direction up --type blocks`). `retry` reopens each phase behind the pass as the expeditor, its `failed:<n>` label removed, so it is dispatched again (or waits for `kitchen turn` when its station is attended: closing a pass never starts a turn there); `retry <station title>` moves it to that station in the same write, the assignee and the `station:` label together, so a reclaim restores it there (the title must read as a station, `<owner>/<station>`; `retry later` is some other word). `stop` closes the order's open phases and then the order, each with the word as reason (bd refuses to close an epic with open children). Any other word leaves the pass closed and the order open, with a note appended to the order saying it stays open for the owner to continue by hand. The pass is then labelled `applied`, so a restart or a repeated tick applies nothing twice; a write bd refuses leaves the pass unlabelled, with the refusal in the log, and the next tick tries again. A `no station for` pass blocks its order and no phase was laid behind it, so `retry` there reopens nothing and leaves the same note on the order: register the station and lay the phase by hand.

The v1 runner spawns `claude` with the Kitchen plugin directory and the plugins the station lists, the prompt that invokes the `kitchen:turn` skill with the phase id, the order's worktree in the station's checkout of the first repository the order names as the working directory (that checkout itself when the phase touches no code), `BEADS_ACTOR`, `BEADS_DIR` and `BEADS_CREDENTIALS_FILE` in the environment, and the model and effort from the phase; a headless turn adds `--print`, `--max-budget-usd` from the phase's `budget.usd` and runs with permission prompts skipped, since no one is there to answer them. The expeditor writes as `<owner>/expeditor` except the take, the claim, the heartbeats and the releases, which beads requires from the holder (another actor's `bd update` of a held bead is refused without `--force`) and which it writes as the station. Its log is `$XDG_STATE_HOME/kitchen/expeditor.jsonl` (`~/.local/state/kitchen/expeditor.jsonl` by default): one JSON object per step per tick, each with the tick number, the step and what it read, dropped or started.

### Worktrees

A phase touches code when its order names repositories. Under the `per-order` worktree policy, each repository the order names and the station offers gets one worktree, `<station checkout>/.kitchen/worktrees/<order>` on branch `kitchen/<order>`, between the take and the claim. Creation fetches `origin` and checks out the remote `kitchen/<order>` branch when another host's turn pushed one, so a handoff continues from the same commits; else it branches from the checkout's upstream (`@{upstream}`, or `HEAD` when the checkout tracks nothing). A worktree that exists already is reused, with the remote branch fast-forwarded in when there is one, so a handoff back to this host also continues from the pushed commits. A git call that fails (no network, a worktree whose branch diverged from the pushed one) releases the take and drops the phase with git's message in the log, every tick until someone puts it right.

At creation the worktree's own config (`git config --worktree`, so the main checkout's identity is untouched) gets the owner as `user.name`, the station title as `kitchen.station`, and `core.hooksPath` pointing at `<station checkout>/.kitchen/hooks`, where Kitchen writes a `prepare-commit-msg` hook that adds a `Kitchen-Station: <station title>` trailer to every commit message. Commits made in a turn therefore carry the owner as author (the author e-mail is the checkout's own, the owner's on the owner's host) and the trailer naming the station. Kitchen's hook runs the repository's own `prepare-commit-msg` under `.git/hooks` first, so what beads or the project installed there keeps running; the other hooks of the repository do not run inside the worktree.

Every tick, before `bd ready` is read, the expeditor lists the worktree directories under each checkout of its stations, reads each order once, removes the worktrees of closed orders (`git worktree remove --force`, then `git branch -D kitchen/<order>`; the remote branch is the closing turn's to delete) and keeps the rest, logging both lists. Cleanup runs on this host's own clock, so an order closed while the host was off is removed on its first tick back. The `.kitchen` directory is untracked in the station checkout; ignore it in `.git/info/exclude` if `git status` there should stay clean.

### The merge gate

The merge phase of a recipe does not merge by hand: it runs the Kitchen plugin's helper, `node "${CLAUDE_PLUGIN_ROOT}/bin/merge-gate.mjs" <phase>`, from the order's worktree. The helper fetches the base branch of the branch's pull request, brings the branch up to date with it (a merge, or a rebase when the repository says so), runs the verify commands the repository lists in its `VERIFY` file in order, records the verified revision, the base revision and the combined output as a note on the phase bead, and merges the pull request only while its head is still the verified revision and the base has not moved; otherwise it verifies again, so nothing unverified or stale reaches the base. A verified revision is evidence for that revision only. After the merge it deletes the remote branch. The file's format and every outcome are in `docs/merge-gate.md`.

## `kitchen turn`

An attended station starts a turn only on the human's word: `kitchen turn <phase>` runs one waiting phase in the foreground, in this terminal. It reads the phase (`bd show`) and your stations, and refuses, before any write, a phase that is not assigned to an attended station of yours on this host (naming the station, its host or its owner), one that is closed or held by a turn (claimed, in progress), and one that is open but not ready because a pass or a dependency still blocks it. It also refuses to run from a session Kitchen started (one carrying `BEADS_ACTOR`): the word is a person's. Then it runs the same steps as the expeditor's dispatch, through the same code: the order is taken and the phase claimed as the station (`bd update --claim` under the station actor, so an expeditor on any host sees the order held and skips it), the order's worktrees are created or reused, and the runner is spawned in interactive mode: `claude` with the model and effort from the phase, the Kitchen plugin and the station's plugins, the actor and the space connection in the environment, without `--print`, without `--max-budget-usd` and without skipping permission prompts, attached to the terminal, so a grill is a conversation in which you reply as often as needed. A take or a claim another turn won first (the race across hosts) is reported and nothing starts; the take is released again when it is the claim that was refused.

The dollar cap is a headless flag, so an attended turn is bounded by the station's wall-clock timeout and the phase's `rounds`, which the turn driver counts. At the session's end the shared handling runs as in a tick: the result line (the exit, since the terminal had the output) is commented on the phase as `<owner>/expeditor` and the order is released as the station. A session that exits non-zero is a failed turn: `kitchen turn` says so and exits with the session's code.

## `kitchen pass`

A pass is answered in a terminal with `kitchen pass`: the Pass view of the UI, for a shell. It lists every open briefed pass (`bd list --type gate --status open`, the gates of type `human` whose reason holds a brief), numbered, each with its order and its brief, then asks which pass and for your word, and closes the chosen one with the word as its reason (`bd close <pass> --reason "<word>"`). An empty answer leaves every pass open; a pass that is open but not yet briefed (a gate laid without a reason) is named under the list and can be answered by id. The phase laid behind the pass becomes ready when it closes and is dispatched on the next tick, or waits for `kitchen turn` when its station is attended; nothing starts from the close itself. For scripts and the smoke, `kitchen pass <pass> <word...>` closes without a question, and `kitchen pass` with nothing on its input only lists.

The close is a person's. A session Kitchen started (one carrying `BEADS_ACTOR`, a station or the expeditor) can list the passes but not answer one: the close goes through the space wrapper, which refuses every close of a human gate under an actor that is not a bare person's name, before any `bd close` is issued. Cooperative, not a security boundary (see `docs/trust-model.md`).

## `kitchen status`

`kitchen status` shows this host from a terminal, reading only. The first line is the expeditor: running, with its pid, last tick and interval, or not running and why. The resident process (`kitchen up --foreground`, what the service unit runs) keeps a state file, `$XDG_STATE_HOME/kitchen/expeditor.json` (`~/.local/state/kitchen/expeditor.json` by default), rewritten after every tick with the tick count and the instant, and marked stopped when `kitchen down` or a signal ends it cleanly (a `--once` run leaves it stopped after its one tick). No file means no expeditor has run here; a stop recorded means it was stopped; a file three intervals or more behind the clock with no stop recorded means the process died or hangs, and status says so plainly. Then, from the space: the turns running at this host's stations (the phases in progress assigned to each station) with their orders; the phases waiting on attended stations (`bd ready` per station), each with the `kitchen turn <phase>` command that starts it; the open passes with their briefs; and each station with whether it is attended and its running count against its `cap:`.

## The turn driver

The Claude Code plugin the runner loads is the `plugin/` directory of the package (published with `dist/`), and it ships exactly two things: the `kitchen:turn` skill, the turn driver, and the Stop hook. It holds no phases and no content skills; recipes are registered into the space with `kitchen recipe add`.

`plugin/skills/turn/SKILL.md` is prose, with Umka's `run` skill as prior art minus its pick step: the phase id is its argument. Its numbered steps are the claim check (the phase's assignee is this session's `BEADS_ACTOR`), reconcile (a closed earlier phase whose artifact is missing is reopened; a closed pass this phase is blocked by and that lacks the `applied` label gets the pass phase's **Apply** section run with the person's word, then the label, so an answer is applied once; an answer that redirects closes the phase with `redirected: <word>` and lays the phase asked for; this phase's artifact present closes it at once), work (the phase's skill, from the phase text copied on the bead, to its **Done when**), close out (commit and push `kitchen/<order>` when it changed; judge each `to` entry's `when` in prose; choose a station by reading the phase's `needs`, the order's `repos` and every station's offers, labels and models, or lay a `no station for <phase>` pass; lay a pass with the pass phase's `ask` as brief and the phase behind it in the same close-out, or skip the pass with a note when its `skip when` holds; one child per item for `per:` with the join phase blocked by all; a `rounds reached: <phase>` pass instead of exceeding `rounds`; close the phase with the artifact as reason) and the result line; the turn that closes the order closes it with `Order done: <PR URL>` as its reason and prints the same line. The driver never closes a pass. The prose is exercised by the smoke, not by unit tests.

The mechanical parts go through the lay helper, `node "${CLAUDE_PLUGIN_ROOT}/bin/lay.mjs"`, so the prose stays short and the bead shapes stay in one place (`src/turn/lay.ts`, built to `dist/` by `npm run build`, which the wrapper needs; tested through the fake runner). It runs only inside a turn, writing through the `bd` wrapper as `<owner>/<station>`, and refuses before any write when something mechanical is wrong:

| Subcommand | What it writes |
| --- | --- |
| `phase <order> <slug> --station <title> --why <reason> [--blocked-by <id>]... [--title <qualifier>] [--note <line>]...` | The child task bead: title `<slug>: <qualifier or order title>`, labels `phase:<slug>` and `station:<title>`, notes `model:` (from the registered phase), `assigned: <reason>` and each `--note`, the registered phase text of the order's pinned revision as description, the station as assignee, `--deps blocked-by:` each id, then `bd dep add` on every open sibling whose phase the new one lists under `from`. A slug no revision the order pinned holds, but one recipe the order has not pinned does, pins that recipe's latest revision at the front of the order's `recipe:` note first, keeping the earlier pins (a slug missing from the order's own revision is never read from a newer one). An open child with the same title is not laid twice: it gets the dependencies instead. Refused: a station not registered, or lacking the phase's model or a repository the order names (exit 2, the gap named); a pass phase; a `rounds` cap reached (exit 3, `rounds reached: <slug>`). |
| `pass <order> [<pass slug>] [--title <title>] [--blocks <id>] --brief <text>` | `bd gate create --type human` blocking the phase laid behind it (the order when none), with the brief as reason, then `bd update` making it the order's child for the owner, labelled `phase:<pass slug>` when laid from a pass phase. `--brief -` reads stdin. A slug that is not a pass phase is refused. |
| `assign <phase> --station <title> --why <reason>` | After the same model and repository check: the `station:` label swapped, the assignee set, `assigned: <reason>` appended to the notes. |
| `dep <id> <blocked-by>...` | One `bd dep add` per blocker. |
| `close <id> --reason <artifact>` | `bd close` of a phase or an order. A pass is refused: a pass closes only under a person's name. |
| `reopen <id>`, `label <id> <label>...`, `note <bead> <key> <value>` | The reconcile writes: status open, labels added (`applied` on a pass), one `<key>: <value>` line of the notes (the order's `class:` on a re-route). |

`plugin/hooks/stop-guard.mjs` is the Stop hook, ported from Umka: while a background command or subagent the turn started still runs, it blocks the stop and names the work, so the session waits for it in the foreground and closes out after; with nothing in flight it prints nothing and the session ends.

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
