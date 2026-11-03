# Intake: `kitchen order add`

Intake is how work enters the space. `kitchen order add` is one intake; the expeditor's source poll (a later slice) is the other, and both go through the same function, `intake` in `src/intake.ts`. Everything intake does is `bd` calls over the one command runner, so the tests script it from a table.

```sh
kitchen order add https://github.com/nomadec/kitchen/issues/7 --recipe umka
kitchen order add docs/training-venues.md --recipe umka --repo sona-is/sona --repo nomadec/kitchen
kitchen order add "Let a venue be booked from the course page" --recipe umka --class proposal
```

| Option | Meaning | Default |
| --- | --- | --- |
| `<source>` | A GitHub issue URL, a file path, or free text (the words after the command) | required |
| `--recipe <name>` | The recipe the order follows; Kitchen never guesses | required |
| `--class <class>` | The class the order enters with: `unsorted`, `question`, `idea`, `proposal`, `spec`, `ticket` or `bug` | inferred, see below |
| `--repo <slug>` | A repository the order names, by remote slug; repeatable | the issue's repository; none for a file or text |

## Reading the source

A GitHub issue is read with `gh issue view <url> --json title,body,url,labels`: the title is the order's title, the body its description, the URL its external reference. A file's first heading (or first line) is the title, its text the description, `file:<absolute path>` the external reference. Free text is its own title, description and reference (`text:<the sentence>`).

## The duplicate check

Before anything is created, intake asks the space for an order with the same external reference, then for one whose reference contains the source's substring: `owner/repo/issues/n` for an issue (so the same issue under another URL form is found), the file's name without its extension, the sentence itself. Umka's `run` skill did the same two checks. A hit prints each order on one line, `<id> <title> (<status>, <class>, <recipe> <revision>) from <reference>`, and the command exits non-zero with nothing created.

## The class

`--class` wins. Otherwise an issue labelled `bug` is a bug, one labelled `ready-for-agent` is a spec, any other issue is a ticket; a file or free text is an idea. A polled source gives the class it was registered with. The recipe must have an entry phase for the class: `umka rev:a1b2c3d has no entry phase for class spec` is refused before any bead is created.

## The beads

The order is an epic bead:

```
bd create "Stale cookie shows a blank page" --type epic --labels loop \
  --notes "repos: nomadec/kitchen
recipe: umka rev:a1b2c3d
class: bug" \
  --description "<the issue body>" --external-ref https://github.com/nomadec/kitchen/issues/7
```

The revision is the `rev:` label of the recipe's phase beads not labelled `superseded`, read before the order is created through `readRecipe` in `src/registered.ts`: re-registering the recipe afterwards never changes this order's path. A recipe whose unsuperseded beads span two revisions (a registration that did not finish) is refused.

The entry phase is the registered phase of that revision whose `entry` lists the class. It is laid as a child task bead of the order, titled `<slug>: <order title>`, labelled `phase:<slug>` and `station:<station title>`, assigned to the station, with a copy of the registered phase text as its description and two note lines:

```
model: claude-opus-5
entry: mechanical
```

The model is the one resolved at lay time from the phase file. The child does not inherit the order's labels (`--no-inherit-labels`): a laid phase is not `loop`.

## The choice of station

This is the one assignment no turn makes (ADR 0002). Among the stations of the order's owner, read with one `bd list --type station --label owner:<owner>`, a station qualifies when its launch spec lists the phase's `model` and every repository the order names. Among those, an unattended station comes before an attended one; then the one with the fewest running turns, counted as the open beads in progress assigned to it (`bd list --assignee <station> --status in_progress`); then the order the space lists them in. No prose is judged: lint guarantees an entry phase has no `needs`.

When no station qualifies, the order is still created and intake lays a pass instead of a phase: a human gate bead titled `no station for <slug>` that blocks the order, made the order's child and assigned to the owner by a second `bd update` (gate create takes neither), whose reason names the gap, for example `reproduce needs model claude-opus-5 and nomadec/kitchen checked out; sona/grill lacks model claude-opus-5; sona/pantry lacks nomadec/kitchen`. The expeditor applies the owner's word on it on a later tick (`retry`, `retry <station>`, `stop`).

## The function

```ts
intake(space, { source, recipe, class, repos, owner })
```

answers one of three results: `existing` with the orders found, `laid` with the order, the revision, the phase bead and the station, or `pass` with the order, the revision, the pass and the gap. `source` is the title, external reference, substring and text as read above; the source poll builds the same shape from a polled item and passes the class the source was registered with.
