---
name: turn
description: "One turn of Kitchen: one phase of one order, in this fresh session. Check the claim, reconcile, work the phase by its skill, close out (push, lay what follows, close the phase), print the result line, stop."
argument-hint: "the id of the laid phase bead this session was started for"
---

# Turn

One **turn** is one **phase** of one **order**, in one fresh session. The order is an epic bead with the `loop` label; its notes name its repositories (`repos:`), its recipe and pinned revision (`recipe:`) and its class (`class:`). The phase is a child task bead of the order: its description is the registered phase text it was laid from (frontmatter and body), its labels are `phase:<slug>` and `station:<owner>/<station>`, its `model:` note the model this session runs on. A **pass** is a gate bead of type `human`, child of the order, holding a brief; a person closes it with their word, and that word is its close reason.

The session carries the space: `BEADS_ACTOR` is this station's title, `BEADS_DIR` and `BEADS_CREDENTIALS_FILE` reach the database, so every `bd` call works from any directory and `bd` reads as this station. The working directory is the order's worktree on branch `kitchen/<order>` in this station's checkout of the first repository the order names, or the station's checkout itself when the order names none. Knowledge travels through durable artifacts only: the tracker and the repository hold deliverables; the beads hold briefs, notes and pointers.

**Writes.** Every write goes through the lay helper, which writes through Kitchen's `bd` wrapper as `<owner>/<station>` and keeps the bead shapes in one place:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/lay.mjs" <subcommand> ...
```

Its subcommands: `phase <order> <slug> --station <title> --why <reason> [--blocked-by <id>]... [--title <qualifier>] [--note <line>]...`, `pass <order> [<pass slug>] [--title <title>] [--blocks <id>] --brief <text>` (`--brief -` reads stdin), `assign <phase> --station <title> --why <reason>`, `dep <id> <blocked-by>...`, `close <id> --reason <artifact>`, `reopen <id>`, `label <id> <label>...`, `note <bead> <key> <value>`. It exits 2 with the reason when it refuses, before any write, and 3 when a `rounds` cap is reached. Reads are plain `bd show <id> --json` and `bd list ... --json`. The driver never closes a pass: `lay close` refuses one, and so does the wrapper under this actor.

**Voice.** Everything a person reads (a brief, a note saying why, a result line) is Simplified Technical English in the vocabulary of the repository's `GLOSSARY.md`: short sentences, one fact or one instruction each, active voice, evidence on its own line under the question. A product decision goes to the person with a recommended answer; an engineering decision the turn takes, records as an ADR when the repository keeps them, and surfaces as one line.

## 1. Claim

The argument is the phase id. `bd show <id> --json`: its `assignee` is `$BEADS_ACTOR` and its status `in_progress`, else the claim is not this turn's: print `<id> busy: claimed by <assignee>` and stop. Read the order (`parent`) the same way, and the phase text from the description: the `skill`, `artifact`, `to` (each entry's `phase`, `when`, `per`), `rounds`, and the body's **Input**, **Run**, **Done when**, **Reconcile** and **Close out** sections. The registered phases of the order's pinned revision are `bd list --type phase --json` narrowed to the `rev:` label of the `recipe:` note; the `to` entries name them by slug.

## 2. Reconcile

Before any work, with the `artifact` line of each phase:

1. **Earlier phases.** For each closed task bead this phase is blocked by (`dependencies` of `bd show`, type `blocks`): its artifact missing, so `lay reopen <that id>`, print `<id> reopened: <that id>, artifact missing` and stop. Nothing is laid on a missing artifact.
2. **Answers.** For each closed pass this phase is blocked by that lacks the `applied` label: its close reason is the person's word. Read the pass phase's text (the `phase:` label on the pass names it in the pinned revision) and run its **Apply** section with the word. Then `lay label <pass id> applied`, so a restart or a repeated tick applies nothing twice.
3. **Redirect.** When Apply judges the word as asking for a different phase than the one laid (`no, research first`): lay that phase per step 4.3, `lay note <order> class <class>` when the redirect moves the order onto another path, `lay close <id> --reason "redirected: <word>"`, print `<id> closed: redirected: <word>` and stop.
4. **This phase.** Its artifact complete: skip the work and go to step 4.2; the close-out lays what follows and closes this phase with the artifact as reason. Partial: continue from where it stops, as the phase text's **Reconcile** says.

## 3. Work

Invoke the phase's `skill` as its **Run** section says, with the facts its **Input** names, and run it to its **Done when**. One phase per turn. A phase whose `needs` says a person is present runs as a conversation in this terminal: the person replies as many times as needed and says when to proceed. A command run in the background is waited for in the foreground before the turn ends; the plugin's Stop hook holds the session until it exits.

## 4. Close out

In this order:

1. **Push.** When the branch changed: commit on `kitchen/<order>` (the worktree's own config gives the owner as author and the `Kitchen-Station:` trailer) and `git push -u origin kitchen/<order>`, so the next station, on any host, continues from these commits. Then the tracker update and the order notes the phase text's **Close out** names.
2. **Lay next.** Judge each `to` entry's `when` in prose against what this turn just did (no `when`: always). Record the judgment in the note you give the laid phase (`--note "when: <rule>; <the facts>"`). An entry whose target is a worked phase is laid with `lay phase <order> <slug> --station <title> --why <reason> --blocked-by <id>`; the helper copies the registered text, writes the model, the labels and the assignee, blocks it on open siblings its `from` lists, and refuses to lay a title that is laid already (it adds the dependency instead). `--title <qualifier>` names a round or an item (`review: round 2`, `implement: <ticket title>`).
3. **Station.** Choose the station for each phase you lay by reading the phase's `needs`, the order's `repos` and every station's `offers:` line, labels (`attended` when a person sits there) and `models` in its launch spec (`bd list --type station --json`). Pick one whose models include the phase's `model`, whose repositories include every slug the order names, and whose offers cover the needs; its title is the `--station`, and `--why` is one sentence saying why. The helper checks the model and the repositories and refuses with the gap when they are missing. When no station qualifies, lay a pass naming the gap instead, for the order's owner: `lay pass <order> --title "no station for <slug>" --brief "<what the phase needs; what each station lacks>"`, blocking the order.
4. **Pass.** An entry whose target is a pass phase (`skill: human`): when its `skip when` rule holds on the facts, lay the phase behind it directly with `--note "skipped: <pass slug>: <rule>; <the facts>"`, so the audit shows which decision was skipped and why. Else a person is needed: lay the phase behind the pass first (step 4.2), then `lay pass <order> <pass slug> --blocks <that id> --brief -` with the brief on stdin, in the shape below, from what the pass phase's `ask` lists. The pass and the phase behind it land in the same close-out, so a person who answers needs no agent to react before work continues. Closing a pass never starts a turn on an attended station; that phase waits for `kitchen turn`.
5. **Fan-out.** For `per: <item>` lay one child per item with `--title <item>`, then the join phase that follows them blocked by all: `lay phase ... --blocked-by <child>...` or `lay dep <join> <child>...`.
6. **Rounds.** A phase whose `rounds` the order has used up is not laid again: `lay phase` refuses with `rounds reached: <slug>` (exit 3). Lay `lay pass <order> --title "rounds reached: <slug>" --brief "<what the rounds produced; what the person can allow>"` instead, blocking the order.
7. **Help.** A phase another station must work is laid the same way, assigned to that station, with this order's next phase blocked by it, so the handoff appears as a step on the order.
8. **Close.** `lay close <id> --reason "<artifact URL, or what was learned, one paragraph>"`. When the phase text's **Close out** closes the order: `lay close <order> --reason "Order done: <PR URL>"`, so the order bead ends with its result line, then `git push origin --delete kitchen/<order>`; each host's expeditor removes the worktrees on a later tick.

The brief of a pass:

```
<pass title>
<What was done, in one or two sentences.>
<The question for the person, in one sentence.> Recommended answer: <one sentence>.
Evidence: <one line: a URL, an id or a count; the facts the question rests on>.
To answer: kitchen pass, or the Pass view.
```

## 5. Result line

The result line closes every turn: the last line this session prints, which the expeditor comments on the phase. One of:

- `<id> closed: <artifact URL, or what was learned, one sentence>`
- `<id> reopened: <earlier id>, artifact missing`
- `<id> busy: claimed by <assignee>`
- `<id> waits: <the phase laid ahead of it, one sentence>`
- `Order done: <PR URL>`, on the turn that closes the order: the same line is the order's close reason

A turn prints the result line and nothing else for the person; the work's own output stays in tool calls. Then stop.
