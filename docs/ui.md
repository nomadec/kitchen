# The UI: served by your expeditor, talking to `bd serve` with a token

The UI is a static single-page app your own host's expeditor serves (story 69, ADR 0003). It reads and writes the space through `bd serve`, the beads HTTP API, with a bearer token; it never holds the SQL credential. The first view is **Pass**: every open pass with its order, its brief and an answer box, so a decision is one short exchange from a phone.

## What `kitchen up` starts

`kitchen up --foreground` (the process the user service runs) starts three things, and `kitchen down` stops all three with the service (`--once`, the one-tick check by hand, serves nothing):

| What | Where | Why |
| --- | --- | --- |
| The expeditor | this process | the tick |
| `bd serve` | `127.0.0.1:<port+1>`, 4818 by default | the beads HTTP API over the space, as a child the expeditor stops on exit |
| The UI server | `127.0.0.1:<port>`, 4817 by default | the bundled page, `/me`, and every `/v0/...` request passed through to `bd serve` |

`--port` on `kitchen up` sets the UI port and is written into the service unit; `bd serve` always takes the next port (`--port 0`, for a check by hand, gives the UI an ephemeral port and `bd serve` 4818, so two such runs on one host collide there). Both bind loopback only: nothing on the network reaches either without a tunnel you set up yourself (below). The expeditor's log line `{"step":"serve","ui":...,"api":...,"token":...}` says where each listens.

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

The UI is tested at two seams: the data layer against a scripted `fetch` (`ui/passes.test.ts`) and the server at its HTTP port against a stand-in for `bd serve` (`src/expeditor/ui.test.ts`). The page itself is exercised by the hand-run smoke.

## Reaching it from a phone

Both ports are loopback-only, and `bd serve` answers only to a loopback `Host` header, so the way in is a tunnel that ends on the host and opens `http://localhost:4817` on your side. The expeditor sets none up; pick one:

- **SSH from the phone.** With an SSH client app that forwards ports (Termius, Blink, Termux's `ssh`), forward local 4817 to `127.0.0.1:4817` on the host (`ssh -N -L 4817:127.0.0.1:4817 <host>`), then open `http://localhost:4817` in the phone's browser. One port is enough: the page and the API share it.
- **Tailscale.** On the host, `tailscale serve --bg 4817` publishes the UI port to your tailnet over HTTPS at `https://<host>.<tailnet>.ts.net`; the phone on the same tailnet opens that. Tailscale terminates the TLS and reaches the UI server on loopback, so bd serve still sees a loopback `Host`. Only your tailnet reaches it, and only with the token.

In both cases the token is the second lock. Paste it on the phone the first time; the browser keeps it.

## Building the UI

`npm run build` compiles `src/` with `tsc` and bundles `ui/app.ts` and `ui/index.html` with esbuild into `dist/ui/`, which the installed package ships and the expeditor serves from beside its `dist/bin`. The browser code imports the actor rules from `src/actor.ts` and nothing else from `src/`; `npm run typecheck` checks it against the DOM types through `tsconfig.ui.json`. There is no framework; the page is drawn with the DOM API.
