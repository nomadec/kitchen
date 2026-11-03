# Intake: `kitchen order add` and the source poll

Intake is how work enters the space. `kitchen order add` is one intake; the expeditor's source poll, the `sources` step of every tick, is the other, and both go through the same function, `intake` in `src/intake.ts`. Everything intake does is `bd` calls over the one command runner (and `gh` for an issue), so the tests script it from a table.

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

When no station qualifies, the order is still created and the entry phase is still laid, unassigned: no assignee and no `station:` label, so no expeditor lists it as ready. Behind it intake lays a pass: a human gate bead titled `no station for <slug>` that blocks the phase, made the order's child and assigned to the owner by a second `bd update` (gate create takes neither), whose reason names the gap, for example `reproduce needs model claude-opus-5 and nomadec/kitchen checked out; sona/grill lacks model claude-opus-5; sona/pantry lacks nomadec/kitchen`. The expeditor applies the owner's word on it on a later tick: `retry <station>` assigns the phase to that station; `retry` alone makes the mechanical choice above again among the owner's stations as they are then, so registering the missing station and answering `retry` resumes the order, and a gap that remains lays the pass again with the gap as it is then; `stop` closes the order.

## The function

```ts
intake(space, { source, recipe, class, repos, owner })
```

answers one of three results: `existing` with the orders found, `laid` with the order, the revision, the phase bead and the station, or `pass` with the order, the revision, the pass and the gap. `source` is the title, external reference, substring and text as read above; the source poll builds the same shape from a polled item and passes the class the source was registered with. The reading of one item (an issue URL through `gh`, a file, free text) is `readItem` in `src/item.ts`, shared by the command and the poll.

## The source poll

Each tick, the `sources` step (`pollSources` in `src/expeditor/poll.ts`) reads the source beads whose `owner:` and `host:` labels are this host's config, with one `bd list --type source --label owner:<owner> --label host:<host>`. A source registered for another host is never listed here, so a source is polled by exactly one host and the cursor on its bead is the whole state of the poll. Each source is read since its cursor, oldest item first, and each item goes through `intake` with the source's recipe and the class it was registered with (never a class inferred from the item). The cursor is then set on the bead (`bd update <source> --notes` with the `cursor:` line replaced), after each item and not once at the end.

The order of the two writes is the guarantee. The order bead is created first and the cursor advanced second, so a failure between them (the host dies, the server refuses the write) leaves the cursor where it was and the item is listed again on the next tick, where the duplicate check finds the order by its external reference, lays nothing, and advances the cursor past it. An item is never lost and never doubled. The same check is what makes re-listing harmless, so an item that already has an order, for any reason, is logged as `existing` and advances the cursor too. A source that fails stops at the item that failed, with the cursor where it was, and the tick goes on with the next source and the next step; the log line names the source, the item and the error.

A `github` source lists the open issues of its target repository updated since the cursor:

```sh
gh issue list --repo nomadec/kitchen --state open --limit 200 \
  --search "sort:updated-asc updated:>=2026-01-02T10:00:00Z" \
  --json number,title,body,url,updatedAt
```

The cursor starts at the registration instant (`kitchen source add --since <instant>` moves it back), so the issues already in the tracker become no orders and the space starts without old work. Open only: a closed issue is no work. The labels are not asked for: the class is the source's. The cursor is the `updatedAt` of each issue in turn. The search is `>=` and not `>`: an issue updated in the same second as the cursor is listed again rather than missed, and the duplicate check skips it. An issue updated after its order was laid (a comment, a label) is listed again for the same reason and skipped the same way. The title, body and URL come from the list itself, with `owner/repo/issues/n` as the substring for the duplicate check and the target repository as the order's one `repos:` entry.

A `file` source reads a JSON Lines file by line offset: the cursor is the number of lines already behind it, `0` when empty. Each line is a JSON string holding one item as `kitchen order add` takes it, a GitHub issue URL, a file path or free text (`"https://github.com/nomadec/kitchen/issues/7"`, `"/home/sona/ideas/venue.md"`, `"Let a venue be booked"`), read through `readItem` like the command's argument. A blank line, or one holding anything but a non-empty string (a JSON object among them: `{"source": ...}` is no item), is no item: it is logged as dropped and the cursor passes it, so a stray line never wedges the source. Three lines and a cursor at `1` lay two orders and leave the cursor at `3`.

Every item writes one log line under the `sources` step: the source, the item's external reference, the cursor it advanced to, and `order` with `laid` (the phase) or `pass`, or `existing` with the orders found. The step ends with the sources polled and the orders laid, and `kitchen up --foreground --once` prints the count as `laid N`.
