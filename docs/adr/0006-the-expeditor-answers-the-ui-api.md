---
status: accepted
---

# The expeditor answers the UI's API itself, and a space may be local

The UI's views read and write the space through HTTP routes in the shape of bd serve's (`/v0/beads/...`). Kitchen's expeditor answers those routes in its own UI server, each with one `bd` call over the space connection every other call of Kitchen uses, under a bearer token it writes at start. It does not run `bd serve`. In the same decision, a space may be local: `kitchen init --local` makes an embedded beads workspace of the host's own, with no Dolt server and no credential, and every command and the UI work against it as against the shared space.

The two go together. `bd serve` refuses to run on an embedded workspace, so a UI tied to it could only serve a shared space, and a person on one machine had to install Dolt, start a server, write a credentials file and set two config keys before a first `kitchen up`. The four other beads UIs on the same server all fork `bd` over an embedded workspace; Kitchen's was the one tied to `bd serve`.

## Consequences

- One loopback port: the page and the API share an origin, and a phone needs one tunnel. The token is the only thing the browser holds; the SQL credential of a shared space is read by `bd` alone.
- The route contract stays bd serve's, so the views are written against one shape and a later move back to `bd serve` for a shared space would not touch them.
- Every `bd` call the API makes goes through the space wrapper, so the cooperative rules of the trust model (a station may not register or answer a pass) apply to the UI as to the CLI.
- A local space is one host's: a second host cannot point at it, and a station handoff across hosts needs a shared space. Moving a host from a local space to the shared one removes the local workspace; its beads are not carried over.
- The host config's server and credential are optional together: both for a shared space, neither for a local one.
