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
npm run build        # compiles src/ to dist/ and bundles the UI into dist/ui/
npm test             # node:test against a fake command runner; no bd or claude needed
npm run typecheck
node dist/bin/kitchen.js --help
```

Every external process Kitchen runs goes through one command runner (argv in; stdout, stderr and exit code out) and every read of the time through one clock. Tests inject a fake runner scripted from a table that records every call, plus a fake clock; both are exported from `@nomadec/kitchen/testing`.

The published package (`npm pack` from a built clone) holds `dist/`, the CLI with the expeditor and the UI bundle under `dist/ui/`, and `plugin/`, the Claude Code plugin the runner loads; nothing else, and no recipe. Before a release, run the smoke below by hand and write its run record into `docs/qa/issue-1-spec-review.md`.

## The commands

The CLI has these ten commands and nothing else (spec: Human surfaces). Each answers `--help`; each has its section below.

| Command | What it does |
| --- | --- |
| `kitchen init` | Write this host's config and verify the connection to the space |
| `kitchen up` | Start this host's expeditor as a user service (`--foreground` runs it here, `--once` one tick) |
| `kitchen down` | Stop the expeditor, leaving claimed phases reclaimable |
| `kitchen order add` | Add an order from a GitHub issue URL, a file or a sentence |
| `kitchen recipe add` | Register a recipe from a plugin directory, a file or a URL |
| `kitchen station add` | Register a station on this host from a template and the values only this host knows |
| `kitchen source add` | Register a polled source with its kind, target, recipe and class |
| `kitchen turn` | Run one waiting phase on an attended station in this terminal |
| `kitchen pass` | List briefed passes and close one with your word |
| `kitchen status` | Show the expeditor, running turns, waiting phases, open passes and caps |

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

The config lands in `$XDG_CONFIG_HOME/kitchen/config.json` (`~/.config/kitchen/config.json` by default) and holds the server, the credential reference, the owner and the host. No secret is written: the password stays in the beads credentials file the reference names. Next to it, `kitchen init` creates the beads workspace under `~/.config/kitchen/space` that every later `bd` command runs from, by running `bd init --server --external` against the configured server under the owner's actor. bd 1.3.1 reads the credentials file for every command after that one, but `bd init` itself takes the password from `BEADS_DOLT_PASSWORD` only, so `kitchen init` reads the `[host:port]` section of the file and passes its password to that one call in its environment; a file or a section that is missing is refused before any command is issued. That call is the verification: when the server cannot be reached, `kitchen init` prints the command's stderr, exits non-zero and writes no config. A database that does not exist on the server yet is created by it, which is how the smoke gets a database of its own. Running `kitchen init` again re-initialises the existing workspace in place (local metadata only; the server's data is untouched) and a failed run never removes a workspace or a config that was already there.

## `kitchen recipe add`

`kitchen recipe add <plugin-dir|file|url> [--recipe <name>]` registers a recipe (glossary: Recipe, Revision): the phase files under the plugin's `phases/` directory (the recipe named by `.claude-plugin/plugin.json`), a directory of phase files, one file, or one fetched from a URL (`--recipe` names the recipe for a file or a URL). The bundle is linted together with the latest revision of every other recipe in the space: symmetric `from` and `to`, every target registered in this bundle or in another recipe, `rounds`, `model` and `budget` well-formed (a scalar or token-count budget is refused), exactly one entry phase per class the bundle claims, an entry phase without `needs`, a pass phase (`skill: human`) with an `ask`; the whole bundle is refused on any finding, before any `bd` write. On success one bead of type `phase` per file is created, titled `<recipe>/<slug>`, labelled `rev:<revision>` (a short hash of the files), with the file as its description, and the previous revision's beads are labelled `superseded`. Laid phases are untouched; an order pins the revision it entered with. An unchanged bundle registers nothing. After a registration, regenerate `docs/phase-graph.md` (below).

## `kitchen station add` and `kitchen source add`

Registration is a human act: both commands run under the owner's bare actor and are refused, before any `bd` call, in a session whose actor is a station. `kitchen station add <template>` registers a station from a `station.json` template (a file, or a plugin directory holding one) plus the values only this host knows: the local path of each repository, the cap, the wall-clock timeout, secret names, and `--attended` when a human sits there. `kitchen source add` registers a polled source with its kind (`github` or `file`), target, recipe and class, polled by this host unless `--host` names another. `docs/registration.md` shows the example template, the beads both commands create and the reader that parses them back.

## `kitchen order add`

`kitchen order add <source> --recipe <name> [--class <class>] [--repo <slug>...]` takes a GitHub issue URL, a file path or free text and makes it an order: an epic bead with the `loop` label, the source as its external reference, a `repos:` note of remote slugs, a `recipe:` note naming the recipe and the revision it pins (the latest at intake) and a `class:` note. A source that is an order already (by external reference, then by its substring) is printed and nothing is created. The class comes from `--class`, else from the source: an issue labelled `bug` is a bug, `ready-for-agent` a spec, any other issue a ticket; a file or free text is an idea. Intake then lays the recipe's entry phase for the class and assigns it mechanically to one of your stations, or lays it unassigned behind a pass titled `no station for <phase>` naming the gap, which your `retry <station>` or `retry` on the pass assigns. `docs/intake.md` shows the beads, the choice of station and the intake function the expeditor's source poll reuses.

## `kitchen up` and `kitchen down`

`kitchen up` installs this host's expeditor as a user service and starts it: a systemd user unit at `~/.config/systemd/user/kitchen-expeditor.service` on Linux, a launchd agent at `~/Library/LaunchAgents/ai.nomadec.kitchen.expeditor.plist` on macOS. The unit runs `kitchen up --foreground --interval <seconds>` (default 5), the long-lived process itself; `kitchen up --foreground --once` runs one tick in the terminal and waits for the turns it started, for a check by hand. `kitchen down` stops the service and removes the unit; the claims its turns hold are left as they are, so their leases go stale and a later tick reclaims them.

The foreground process also serves the UI and runs `bd serve` beside the tick, both bound to loopback: the UI on `--port` (4817 by default, written into the unit) and `bd serve` on the next port, behind a token file the expeditor generates at each start (`~/.local/state/kitchen/serve.token`, mode 0600). The UI server passes every `/v0/...` request through to `bd serve` with the browser's bearer token, so the page and the API share one port and the UI never holds the SQL credential. `kitchen down` stops all three with the service. The first view is Pass: every open pass with its order, brief and an answer box; the word closes the gate under your name. `docs/ui.md` has the token, the ports and how to reach the page from a phone.

Each tick is a sequence of named steps, in the order the spec lays them: `config`, `stations`, `gates`, `passes`, `sources`, `leases`, `reclaim`, `worktrees`, `ready`, `orders`, `caps`, `attended`, `dispatch`. What runs today: the stations whose owner and host match the config are read; the sources whose owner and host match are polled since the cursor on each bead, a `github` source for the issues of its repository updated since then (through `gh issue list`), a `file` source for the lines of a JSON Lines file after a line offset, and each new item becomes an order through intake with the source's recipe and class, the cursor advanced on the bead after each order (so an interruption between the two re-lists the item and the duplicate check, not a second order, answers it; `docs/intake.md`); the typed gates are evaluated (`gates`) and the word on closed Kitchen-laid passes applied (`passes`), both below; the turns whose children live are listed (`leases`); the stale leases in the space are reclaimed (`bd reclaim`) and, since reclaim clears the assignee, each reclaimed phase is assigned again to the station its `station:` label names, so it returns to the station it was laid for (a reclaimed order has no such label and stays released); the worktrees of closed orders under this host's checkouts are removed (see below); `bd ready` is listed per station assignee; a phase whose order is taken by a turn (a `loop` epic in progress and assigned to a station, on any host) is dropped; a station at its `cap:` is dropped; a phase on an attended station is labelled `waiting` and listed with the `kitchen turn <phase>` command that starts it; every remaining phase on an unattended station is started: the order is taken (`bd update <order> --claim` under the station actor, the per-order limit held in the space), its worktrees are created or reused, the phase is claimed the same way, and the runner is spawned. At the turn's end the last line of the session's output is commented on the phase bead and the order is released.

While a turn's child lives, the expeditor heartbeats the phase's lease and the order's take (`bd heartbeat`, as the station, the holder) once a minute, well under bd's five-minute lease; a heartbeat bd refuses (the lease reclaimed, or the bead closed under the turn) ends the heartbeats with the refusal in the log. The station's wall-clock `timeout` kills a child that outlives it, and the kill is logged. When the child exits the phase is read back: closed, the turn is done. Left open, the phase is reclaimed: the station, the holder, sets it open again in one write that keeps it assigned to the station its `station:` label names, as the tick's reclaim step does after `bd reclaim`. A non-zero exit, a budget overrun the harness reports (`Budget limit reached` on its standard error) or the kill is a failure: `failed:<n>` counts it in that same write; at `failed:2` a pass titled `turn failed: <phase slug>` is laid for the owner, as a child of the order, blocking the phase, and no further turn is started on it (a phase `bd ready` lists with `failed:2` anyway is dropped). A child a stop signal ended (SIGTERM, SIGINT or SIGHUP: `kitchen down` stopping the service, and the session with it) that was not the wall clock's is reclaimed, not failed, so a restart loses nothing; any other signal (the kernel's SIGKILL at an out-of-memory, a SIGSEGV) is a failure like a crash, so a child that dies the same way on every start reaches the `turn failed` pass instead of being started every tick. A phase or an order another station holds by the end (its lease reclaimed and taken elsewhere after a refused heartbeat) is left to that holder. The order is released on every other path. The `turn` line of the log carries the exit code, the result line (the session's last line, else the `result:` note the driver wrote during this turn when the terminal had its output, a note found there at the claim being an earlier turn's, else the exit code), the outcome (`closed`, `reclaimed`, `failed`), the failure and its count, and the pass; an ending that fails on its own account (a bd call refused, an answer holding no bead, anything else it throws) is logged with `failed` and left to `bd reclaim`, and the service goes on: nothing awaits an ending but the shutdown, so no rejection is left to end the process.

### Typed gates and the word on a Kitchen-laid pass

An external wait is a gate bead of type `timer`, `gh:pr`, `gh:run` or `bead`, laid by a turn in front of the phase that follows it. Each tick runs `bd gate check`, which evaluates them itself (`gh pr view` for a merged PR, `gh run view` for a green workflow, the clock for a timer, the target's status for a bead gate) and closes the resolved ones; the phase behind a closed gate is in `bd ready` from the next tick and starts like any other, so no session is spent on the wait. The `gates` line of the log carries the counts bd printed and the ids it resolved, or `none open`.

A pass a recipe lays carries an Apply section, and the turn behind it applies the word (the pass's close reason). The three passes Kitchen itself lays, `no station for <phase>` at intake, `rounds reached: <phase>` by the turn driver and `turn failed: <phase>` at the second failure, carry none, so the `passes` step applies their word on the tick after the pass closes: the owner's closed gates not labelled `applied` are listed (`bd list --type gate --assignee <owner> --status closed --exclude-label applied`: a pass is laid for its owner, a typed gate for no one), a recipe's pass is passed over, and for each Kitchen-laid pass the beads it blocks are read (`bd dep list <pass> --direction up --type blocks`). `retry` reopens each phase behind the pass as the expeditor, its `failed:<n>` label removed, so it is dispatched again (or waits for `kitchen turn` when its station is attended: closing a pass never starts a turn there); `retry <station title>` moves it to that station in the same write, the assignee and the `station:` label together, so a reclaim restores it there (the title must read as a station, `<owner>/<station>`; `retry later` is some other word). The station named must be registered to the owner and lack nothing the phase needs, its model and every repository the order names, the check the lay helper makes; a title that is not (a typo) or a station that lacks something leaves the phase as it is, with a note on the order saying so, so nothing is assigned to a station that is not there. `stop` closes the order's open phases and then the order, each with the word as reason (bd refuses to close an epic with open children). Any other word leaves the pass closed and the order open, with a note appended to the order saying it stays open for the owner to continue by hand. The pass is then labelled `applied`, so a restart or a repeated tick applies nothing twice; a write bd refuses leaves the pass unlabelled, with the refusal in the log, and the next tick tries again. Behind a `no station for` pass the phase is laid unassigned: `retry <station title>` assigns it there, and `retry` alone makes intake's mechanical choice again among the owner's stations as they are now, so registering the missing station and answering `retry` resumes the order; a gap that remains lays the pass again, behind the same phase, with the gap as it is now.

The v1 runner spawns `claude` with the Kitchen plugin directory and the plugins the station lists, the prompt that invokes the `kitchen:turn` skill with the phase id, the order's worktree in the station's checkout of the first repository the order names as the working directory (that checkout itself when the phase touches no code), `BEADS_ACTOR`, `BEADS_DIR` and `BEADS_CREDENTIALS_FILE` in the environment, and the model and effort from the phase; a headless turn adds `--print`, `--max-budget-usd` from the phase's `budget.usd` and runs with permission prompts skipped, since no one is there to answer them. The expeditor writes as `<owner>/expeditor` except the take, the claim, the heartbeats and the releases, which beads requires from the holder (another actor's `bd update` of a held bead is refused without `--force`) and which it writes as the station. Its log is `$XDG_STATE_HOME/kitchen/expeditor.jsonl` (`~/.local/state/kitchen/expeditor.jsonl` by default): one JSON object per step per tick, each with the tick number, the step and what it read, dropped or started.

### Worktrees

A phase touches code when its order names repositories. Under the `per-order` worktree policy, each repository the order names and the station offers gets one worktree, `<station checkout>/.kitchen/worktrees/<order>` on branch `kitchen/<order>`, between the take and the claim. Creation fetches `origin` and checks out the remote `kitchen/<order>` branch when another host's turn pushed one, so a handoff continues from the same commits; else it branches from the checkout's upstream (`@{upstream}`, or `HEAD` when the checkout tracks nothing). A worktree that exists already is reused, with the remote branch fast-forwarded in when there is one, so a handoff back to this host also continues from the pushed commits. A git call that fails (no network, a worktree whose branch diverged from the pushed one) releases the take and drops the phase with git's message in the log, every tick until someone puts it right.

At creation the worktree's own config (`git config --worktree`, so the main checkout's identity is untouched) gets the owner as `user.name`, the station title as `kitchen.station`, and `core.hooksPath` pointing at `<station checkout>/.kitchen/hooks`. On every turn, the worktree created or reused, Kitchen writes that directory afresh with every client-side hook git runs, each forwarding to the repository's own hook of the same name: the hooks directory the repository's `core.hooksPath` names (read from the repository's config, then the global one, then the system one; a relative path stays relative, since git runs a hook from the root of the working tree), else `.git/hooks`. So what beads or the project installed keeps running inside the worktree, and a hook's refusal is the worktree's. The `prepare-commit-msg` forward then adds a `Kitchen-Station: <station title>` trailer to every commit message. Commits made in a turn therefore carry the owner as author (the author e-mail is the checkout's own, the owner's on the owner's host) and the trailer naming the station.

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

The Claude Code plugin the runner loads is the `plugin/` directory of the package (published with `dist/`), and it ships the `kitchen:turn` skill, the turn driver, the Stop hook, and the two helpers the driver calls, `bin/lay.mjs` and `bin/merge-gate.mjs`, which are the driver's hands rather than content of their own (`src/plugin/manifest.test.ts` pins that list). It holds no phases and no content skills; recipes are registered into the space with `kitchen recipe add`.

`plugin/skills/turn/SKILL.md` is prose, with Umka's `run` skill as prior art minus its pick step: the phase id is its argument. Its numbered steps are the claim check (the phase's assignee is this session's `BEADS_ACTOR`), reconcile (a closed earlier phase whose artifact is missing is reopened; a closed pass this phase is blocked by and that lacks the `applied` label gets the pass phase's **Apply** section run with the person's word, then the label, so an answer is applied once; an answer that redirects closes the phase with `redirected: <word>` and lays the phase asked for; this phase's artifact present closes it at once), work (the phase's skill, from the phase text copied on the bead, to its **Done when**), close out (commit and push `kitchen/<order>` when it changed; judge each `to` entry's `when` in prose; update the order's `class:` note when an edge moves it onto another path; choose a station by reading the phase's `needs`, the order's `repos` and every station's offers, labels and models, or lay the phase unassigned behind a `no station for <phase>` pass; lay a pass with the pass phase's `ask` as brief and the phase behind it in the same close-out, or skip the pass with a note when its `skip when` holds; one child per item for `per:` with the join phase blocked by all; a `rounds reached: <phase>` pass with the extra round laid behind it instead of exceeding `rounds` on its own; close the phase with the artifact as reason) and the result line, which it also writes as the phase's `result:` note so an attended turn's line reaches the bead; the turn that closes the order closes it with `Order done: <PR URL>` as its reason and prints the same line. The driver never closes a pass. The prose is exercised by the smoke, not by unit tests.

The mechanical parts go through the lay helper, `node "${CLAUDE_PLUGIN_ROOT}/bin/lay.mjs"`, so the prose stays short and the bead shapes stay in one place (`src/turn/lay.ts`, built to `dist/` by `npm run build`, which the wrapper needs; tested through the fake runner). It runs only inside a turn, writing through the `bd` wrapper as `<owner>/<station>`, and refuses before any write when something mechanical is wrong:

| Subcommand | What it writes |
| --- | --- |
| `phase <order> <slug> [--station <title>] --why <reason> [--blocked-by <id>]... [--behind <pass>] [--title <qualifier>] [--note <line>]...` | The child task bead: title `<slug>: <qualifier or order title>`, labels `phase:<slug>` and `station:<title>`, notes `model:` (from the registered phase), `assigned: <reason>` and each `--note`, the registered phase text of the order's pinned revision as description, the station as assignee, `--deps blocked-by:` each id, then `bd dep add` on every open sibling whose phase the new one lists under `from`. Without `--station` the phase is laid unassigned (no assignee, no `station:` label, an `unassigned: <reason>` note) for a `no station for` pass to block and the person's `retry <station>` to assign. `--behind <pass>` blocks it on that pass and passes over the `rounds` cap, since the person's word on the pass grants the round; the pass must be an open human gate of this order, anything else is refused. A slug no revision the order pinned holds, but one recipe the order has not pinned does, pins that recipe's latest revision at the front of the order's `recipe:` note first, keeping the earlier pins (a slug missing from the order's own revision is never read from a newer one). An open child with the same title is not laid twice: it gets the dependencies instead. Refused: a station not registered, or lacking the phase's model or a repository the order names (exit 2, the gap named); a pass phase; a `rounds` cap reached (exit 3, `rounds reached: <slug>`). |
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

## The trust model

Who writes as whom is provenance, not a lock. A person writes as their name, a turn as `<owner>/<station>`, the expeditor as `<owner>/expeditor`, each as `--actor` on every `bd` write. Kitchen's `bd` wrapper, CLI and UI refuse, under a station actor, writes to beads of type `phase`, `station` and `source` and the closing of a pass. That is the whole promise, and its limit is plain: every person and their stations share that person's one SQL credential, beads treats the actor as provenance and not as authenticated identity, and a station that reaches `bd`, the HTTP API or the database directly, or passes `--actor <owner>` itself, is not stopped. Cooperative, not a security boundary: `docs/trust-model.md` says where it stops and ADR 0003 records the decision.

## The smoke

One smoke, run by hand before a release, proves the loop against a real `bd` and a real `claude` (spec story 81). From a built clone, with a server and a SQL user allowed to create a throwaway database:

```sh
npm run build
node scripts/smoke.ts --server rbn3:3307 --user sona --credential ~/.config/beads/credentials
```

It creates a database of its own on the server (`kitchen_smoke_<stamp>`, through `kitchen init` under a config and state directory of the run's own, so this host's kitchen config is untouched), registers a recipe from a plugin directory (`--plugin`; the fixture under `scripts/smoke-fixture` by default: an entry phase `greet` for an idea, the pass `approve` and the phase `confirm` behind it; the Umka plugin's directory once its migration has landed), registers one unattended station on this host from the plugin's `station.json` (else the fixture's), adds one synthetic order of class `idea` (`--class` for another), and runs the expeditor tick by tick (`kitchen up --foreground --once`) within `--minutes`. It asserts that the order reaches its first pass with a brief, laid and assigned by a turn; that `kitchen pass` under a station actor is refused and the pass closes only under the human actor; that the phase behind the pass runs and applies the word (`--word`, `go` by default) once, with the pass labelled `applied` and a further tick starting nothing; and that the order closes with its result line. It prints the bead ids it created, the expeditor log and one run-record row per check, PASS, FAIL or BLOCKED (a check that cannot run on this host, such as a `claude` that is not signed in), and exits 0 only when every check passed. The database is left on the server for the record and dropped by hand.

For a host without a team server, a throwaway Dolt SQL server does: `DOLT_ROOT_HOST=% DOLT_ROOT_PASSWORD=<pw> dolt sql-server --host 127.0.0.1 --port 3399` in an empty directory, a credentials file with a `[127.0.0.1:3399]` section, then `--server 127.0.0.1:3399 --user root`.

On a host where `claude` is not signed in, `PATH=scripts/smoke-standin:$PATH` puts a stand-in `claude` in front of the real one: a shell script that does, mechanically, what the turn driver asks for the fixture's two worked phases through the lay helper. It proves the harness (every `bd` write and read, the expeditor, `kitchen pass`, the answer applied once) and nothing about the turn driver's prose; a release still needs the real run.

The run record goes into `docs/qa/issue-1-spec-review.md`, which also lists the hand-run journeys beyond the smoke.

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
| Pass | A gate bead of type `human`; the UI closes it through `bd serve` with the word as the reason | yes |
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
