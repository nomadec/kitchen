# Registering a station and a source

Registration is the human act of adding a recipe, a station or a source to the space (glossary: Registration). `kitchen station add` and `kitchen source add` run under your bare actor, the owner `kitchen init` wrote into the host config. In a session Kitchen started, where the actor is a station or the expeditor, both are refused before any `bd` call is issued: a station by the `bd` wrapper, the expeditor by the command. The refusal names the cooperative rule (`docs/trust-model.md`).

## A station

A station is a prepared place (ADR 0005): a host, the repositories checked out there, the plugins and tooling present, the models it can launch, how many turns it runs at once and whether a human sits there. It is registered from a template plus the values only this host knows.

### The template

The template gives the shape: everything in the launch spec that is not about one host. It is a `station.json` file, shipped in a plugin directory or kept on disk. The one below is the example the tests use.

```json
{
  "name": "grill",
  "offers": "nomadec/kitchen and sona-is/sona checked out; Node 24 and Elixir on the path; opus and sonnet",
  "provider": "claude",
  "models": ["claude-opus-5", "claude-sonnet-5"],
  "auth": "subscription",
  "plugins": ["umka@nomadec", "kitchen@nomadec"],
  "skills": ["umka:implement", "umka:review"],
  "repositories": ["nomadec/kitchen", "sona-is/sona"],
  "worktrees": "per-order",
  "budget": { "usd": 5, "effort": "high" }
}
```

| Key | Meaning |
| --- | --- |
| `name` | The default station name; `--name` overrides it. Without one, `--name` is required |
| `offers` | What the station offers, in prose, for the laying turn to read against a phase's needs; `--offers` overrides it |
| `provider` | The runner: `claude` is the only one in v1 |
| `models` | The models the station can launch; a phase goes only to a station listing its model |
| `auth` | How the provider signs in: `subscription` for the claude CLI's own login |
| `plugins`, `skills` | What the session loads |
| `repositories` | The repositories the station offers, by remote slug; the host gives each a local path |
| `worktrees` | The worktree policy: `per-order` puts each order in its own worktree inside the checkout |
| `budget` | The budget per turn: a dollar cap and an effort, the harness flags of a headless turn |

A template that lacks a key is refused naming the key.

### The values

```sh
kitchen station add path/to/station.json \
  --repo nomadec/kitchen=/home/sona/src/kitchen \
  --repo sona-is/sona=/home/sona/src/sona \
  --cap 2 --timeout 45m --secret GITHUB_TOKEN
```

The template argument is the file, or a plugin directory holding `station.json`.

| Option | Meaning | Default |
| --- | --- | --- |
| `--repo <slug>=<path>` | The local checkout of one repository the template offers; one per repository, every one required | |
| `--cap <n>` | How many turns the station runs at once | required |
| `--timeout <duration>` | The wall-clock timeout of one turn: `45m`, `2h`, `90s` | required |
| `--name <name>` | The station's name | the template's |
| `--owner <person>` | The station's owner | the host config's owner |
| `--host <hostname>` | The host the station runs on | the host config's host |
| `--offers <prose>` | What the station offers | the template's |
| `--secret <name>` | The name of a secret the host resolves at launch, repeatable. Names only; the value never reaches the space. At launch the expeditor reads each name from its own environment, else from the file `~/.config/kitchen/secrets/<name>` (`$XDG_CONFIG_HOME/kitchen/secrets/<name>`; the value is its content, trailing newline dropped), into the session's environment, and refuses the start when a name is set nowhere, naming the file. A user service has a minimal environment, so the file is the usual place | none |
| `--attended` | A human sits at this station; the expeditor never starts its turns, `kitchen turn` does | unattended |

A missing required value is refused naming it, before any `bd` call. A `--repo` for a slug the template does not offer is refused too.

### The bead

The command issues one `bd create` under your actor. The station bead is of type `station`, titled `<owner>/<name>` (`sona/grill`), labelled `owner:sona`, `host:sona-laptop`, `cap:2`, and `attended` when a human sits there. Its note carries the `offers:` line and the launch spec as a fenced JSON block:

````
offers: nomadec/kitchen and sona-is/sona checked out; Node 24 and Elixir on the path; opus and sonnet

```json
{
  "provider": "claude",
  "models": ["claude-opus-5", "claude-sonnet-5"],
  "auth": "subscription",
  "plugins": ["umka@nomadec", "kitchen@nomadec"],
  "skills": ["umka:implement", "umka:review"],
  "repositories": [
    { "slug": "nomadec/kitchen", "path": "/home/sona/src/kitchen" },
    { "slug": "sona-is/sona", "path": "/home/sona/src/sona" }
  ],
  "worktrees": "per-order",
  "cap": 2,
  "budget": { "usd": 5, "effort": "high" },
  "timeout": "45m",
  "secrets": ["GITHUB_TOKEN"]
}
```
````

The launch spec is provider-neutral in shape: a Codex runner reads the same keys. The title is also the station's turn actor (`sona/grill`) and the assignee of every phase laid for it.

## A source

A source is where orders come from. A polled source is registered with its kind, its target, the recipe its orders follow and the class its items enter with; the expeditor of the one host named on the bead polls it since the cursor kept on the bead.

```sh
kitchen source add --kind github --target nomadec/kitchen --recipe umka
kitchen source add --kind file --target /home/sona/intake.jsonl --recipe umka --class idea --host rbn3
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--kind <github\|file>` | A GitHub repository's issues, or a JSONL file read by offset | required |
| `--target <target>` | The repository slug for `github`, the JSONL path for `file` | required |
| `--recipe <name>` | The recipe every order from this source follows | required |
| `--class <class>` | The class its items enter with: `unsorted`, `question`, `idea`, `proposal`, `spec`, `ticket` or `bug` | `unsorted` |
| `--host <hostname>` | The one host whose expeditor polls it: another of your hosts, since a host runs only its owner's work (ADR 0003) | the host config's host |

The source bead is of type `source`, titled `<kind>:<target>` (`github:nomadec/kitchen`), labelled `owner:sona`, `host:sona-laptop` and `kind:github`, with a note of `<key>: <value>` lines:

```
target: nomadec/kitchen
recipe: umka
class: unsorted
cursor:
```

The cursor is empty until the first poll; the expeditor sets it on the bead after each order it lays, so moving the source to another host (`--host`, or editing the label) loses nothing. For a `github` source it is the `updatedAt` of the last issue polled; for a `file` source it is the number of lines of the JSONL file already behind it. The poll itself, and why the cursor advances after each order and not before, is in `docs/intake.md`.

## Reading them back

Intake, the laying turn and the expeditor read stations and sources through the reader in `src/registered.ts`: `readStations(space, { owner, host })` and `readSources(space, { host })` are one `bd list --type <station|source>` each, narrowed by labels; `readStation` and `readSource` are one `bd show`. Each parses the bead into the same shape the commands wrote: title, labels, the `offers:` line and the launch spec for a station; the labels and the note lines for a source. A bead that is not what it should be (a missing label, no launch spec, an unknown kind) is refused naming the bead and the gap.
