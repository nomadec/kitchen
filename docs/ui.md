# The UI: served by your expeditor, talking to `bd serve` with a token

The UI is a static single-page app your own host's expeditor serves (story 69, ADR 0003). It reads and writes the space through `bd serve`, the beads HTTP API, with a bearer token; it never holds the SQL credential. It has four views, each a link a phone can bookmark: **Pass** (`#pass`, the page's default), every open pass with its order, its brief and an answer box, so a decision is one short exchange; **Orders** (`#orders`), where everything stands; **Stations** (`#stations`), what your agents are doing and what waits on you; **Activity** (`#activity`), what changed while you were away. Only Pass writes.

## What `kitchen up` starts

`kitchen up --foreground` (the process the user service runs) starts three things, and `kitchen down` stops all three with the service (`--once`, the one-tick check by hand, serves nothing):

| What | Where | Why |
| --- | --- | --- |
| The expeditor | this process | the tick |
| `bd serve` | `127.0.0.1:<port+1>`, 4818 by default; a free port of the host's choosing under `--port 0` | the beads HTTP API over the space, as a child the expeditor stops on exit |
| The UI server | `127.0.0.1:<port>`, 4817 by default | the bundled page, `/me`, and every `/v0/...` request passed through to `bd serve` |

`--port` on `kitchen up` sets the UI port and is written into the service unit; `bd serve` takes the next port. `--port 0`, for a check by hand, gives the UI an ephemeral port and `bd serve` a free port the expeditor picks (bd serve needs the port on its command line, so the expeditor binds port 0 once to learn a free one and releases it), so two such runs on one host do not collide. Both bind loopback only: nothing on the network reaches either without a tunnel you set up yourself (below). The expeditor's log line `{"step":"serve","ui":...,"api":...,"token":...}` says where each listens.

`bd serve` needs the space's Dolt SQL server (`docs/onboarding.md`); it refuses to start otherwise. When it exits on its own the expeditor keeps ticking, logs one line `{"step":"serve","ended":"bd serve exited <code>","stderr":...}`, and every `/v0/...` request through the UI answers 502 naming the port nothing listens on. `kitchen down` then `kitchen up` starts it again.

## The token

At every start the expeditor generates a fresh token, 32 random bytes as hex, and writes it, one line, to

```
~/.local/state/kitchen/serve.token      ($XDG_STATE_HOME/kitchen/serve.token)
```

with mode 0600, whole and renamed into place. `bd serve` runs with `--auth-token-file` pointing at it, so every request to the API needs `Authorization: Bearer <token>`, `/healthz` excepted; without it bd serve answers 401. `bd serve` re-reads the file while running, so a token written there is live within a second and a line removed stops working as fast.

The token is yours, the way the credential is: whoever holds it can read every bead and close passes under any actor they name. Read it from the file on the host (`cat ~/.local/state/kitchen/serve.token`) and paste it into the UI once; the page keeps it in the browser's local storage and asks again when bd serve refuses it. Do not paste it into the space, an issue or a commit. Restarting the expeditor (`kitchen down`, `kitchen up`) rotates it.

## No credentials in the UI

The SQL password lives in the beads credentials file on the host and is read by `bd` alone: by the `bd` commands the CLI and the expeditor run, and by the `bd serve` child. The UI server passes a request through to `bd serve` with the bearer token the browser sent and nothing of its own; it serves files and answers `/me` (the owner and host from the host config, no secret). The page, its script and the browser hold the token and your name, never the credential. A token that leaks costs a restart; a credential that leaks costs a rotation on the server (`docs/onboarding.md`).

## The Pass view

The page lists every open gate of type `human` from `GET /v0/beads/issues?type=gate&status=open`, with its title, the order it belongs to (the gate's parent, read for its title), who laid it and the brief: the reason the station wrote. Typing a word and pressing Answer posts

```
POST /v0/beads/issues/<pass>:close   {"actor": "<owner>", "reason": "<word>"}
```

so the word is the pass's close reason, as `kitchen pass` writes it, and the phase laid behind the pass becomes ready for the next tick. The actor is the owner from `/me`: the bare human name. The view refuses, before any request, to close under a station or expeditor actor (`sona/oven`, `sona/expeditor`), the same cooperative rule the `bd` wrapper and the CLI apply (`docs/trust-model.md`); the rule is cooperative, and nothing in bd serve stops a caller who names the owner as the actor themselves.

## The Orders view

Every open order and the twenty closed last (`GET /v0/beads/issues?type=epic&label=loop`, then `...&status=closed&limit=20`), grouped by status in the order in progress, open, blocked, deferred, closed, with its class, the recipe and the `rev:<revision>` it pinned (the first pin of its `recipe:` note: the recipe it walks now), and where it is: the phases among its open children (`GET /v0/beads/issues?parent=<order>`), each as `<slug> (<state> at <station>)` where the state is `in progress` for a phase a turn is working, `waiting` for one the expeditor labelled `waiting` at an attended station, and `laid` for one not started. An order with no open phase shows `none laid`, or `done` when closed. The id links to the order's source when it carries an external reference.

## The Stations view

Every registered station in the space, not only this host's (`GET /v0/beads/issues?type=station`), with its title, attended or not, owner, host, what it offers and the turns it runs against its cap (`GET /v0/beads/issues?assignee=<station>&status=in_progress`, the order a station holds left out of the count). An attended station also lists the phases waiting for its human (`GET /v0/beads/ready?assignee=<station>`, kept to those the expeditor labelled `waiting` on its last tick: not held by another turn, not over the cap), each with the exact command to run in a terminal on that host:

```
kitchen turn <phase>
```

There is no start button in v1 (spec: out of scope): the turn is attended, so it runs in your own terminal, where the runner is interactive. A station bead that does not parse stops the view with the field it lacks, the same message `kitchen status` prints.

## The Activity view

The latest fifty records of the events journal, newest first, each with when, who (the actor: you, a station or the expeditor), what (`create`, `update`, `close`, `dep_add`, as the journal names it), the bead with its title, and a detail: the close reason, the dependency added, or the bead's status and station. The journal route reads forward from a sequence number (`GET /v0/beads/events?since=<seq>&limit=<n>`), so the view asks for the head first and then for the fifty records behind it. A space whose journal is off (`bd config set events-journal true` on the server; `scripts/install-server.sh` sets it) shows bd serve's refusal instead.

The UI is tested at two seams: each view's data layer against a scripted `fetch` (`ui/passes.test.ts`, `ui/orders.test.ts`, `ui/stations.test.ts`, `ui/activity.test.ts`, all through `ui/scripted-fetch.ts`) and the server at its HTTP port against a stand-in for `bd serve` (`src/expeditor/ui.test.ts`). The page itself, and the navigation between the views, is exercised by the hand-run smoke.

## Reaching it from a phone

Both ports are loopback-only, and `bd serve` answers only to a loopback `Host` header, so the way in is a tunnel that ends on the host and opens `http://localhost:4817` on your side. The expeditor sets none up; pick one:

- **SSH from the phone.** With an SSH client app that forwards ports (Termius, Blink, Termux's `ssh`), forward local 4817 to `127.0.0.1:4817` on the host (`ssh -N -L 4817:127.0.0.1:4817 <host>`), then open `http://localhost:4817` in the phone's browser. One port is enough: the page and the API share it.
- **Tailscale.** On the host, `tailscale serve --bg 4817` publishes the UI port to your tailnet over HTTPS at `https://<host>.<tailnet>.ts.net`; the phone on the same tailnet opens that. Tailscale terminates the TLS and reaches the UI server on loopback, so bd serve still sees a loopback `Host`. Only your tailnet reaches it, and only with the token.

In both cases the token is the second lock. Paste it on the phone the first time; the browser keeps it.

## Building the UI

`npm run build` compiles `src/` with `tsc` and bundles `ui/app.ts` and `ui/index.html` with esbuild into `dist/ui/`, which the installed package ships and the expeditor serves from beside its `dist/bin`. The browser code imports from `src/` only what reads a bead back (the actor rules, the order and its class, the station, the laid phase's labels, the pass's order naming, and the note and label fields), none of which touches Node; `npm run typecheck` checks it against the DOM types through `tsconfig.ui.json`, whose `include` lists those files. There is no framework; the page is drawn with the DOM API.
