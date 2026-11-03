# The merge gate

The merge phase of a recipe merges an order's pull request through one helper, so that nothing unverified or stale reaches the base branch (spec story 76). The spec's "verified revision" is a git commit; it is not the glossary's Revision, a version of a registered recipe. The helper lives in the Kitchen plugin, `plugin/bin/merge-gate.mjs`, beside the lay helper and wired the same way (it imports the built package under `dist/`, so the kitchen package the plugin sits in must have run `npm run build`), and the turn that works the merge phase calls it from the order's worktree:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/merge-gate.mjs" <phase>
```

`<phase>` is the id of the merge phase bead the turn holds; the note goes there. The helper runs under the actor of the session (`BEADS_ACTOR`, the station), over the host config `kitchen init` wrote, and every `bd` write carries that actor. It exits 0 when the pull request is merged and 1 when it refuses; what it did is on its standard output or error, and in the note. The migrated Umka `merge.md` calls it in place of its own `gh pr merge`.

## The `VERIFY` file

The verify commands come from a file inside the repository, read from the order's worktree: `VERIFY` at the repository root. One command per line, run in order by `sh -c` in the worktree, each with the exit code deciding:

```
# how the branch meets the base: merge (the default) or rebase
update: merge
# how the pull request is merged: merge (the default), squash or rebase
pr: merge

npm run typecheck
npm test
```

- A blank line or a line starting with `#` is skipped.
- `update: merge` or `update: rebase` states the repository's convention for bringing the order's branch up to date with the base. Without the line the branch is merged.
- `pr: merge`, `pr: squash` or `pr: rebase` states how `gh pr merge` merges the pull request. Without the line it is a merge commit.
- Every other line is a command. The first non-zero exit refuses the merge; the commands after it do not run.

The `update:` convention is read from the branch before it is brought up to date; the commands and the `pr:` method are read after, from the revision that is verified, so a base that changed the file is verified by its own list. A repository without a `VERIFY` file is refused: an unverified branch never merges by omission. A file with no commands verifies by doing nothing, which a repository states on purpose. A directive with another value (`update: squash`) is refused.

## What the helper does

1. Reads the worktree's branch (`kitchen/<order>`) and the open pull request for it (`gh pr view`): its number, base branch and head. No open pull request, or one for another branch: refused, with no note, since nothing was verified.
2. Fetches `origin`. When the worktree is not at the pull request's head, the remote branch is fast-forwarded in (`git merge --ff-only origin/kitchen/<order>`): someone pushed past the worktree, and the gate verifies what the pull request holds. A worktree ahead of the pull request (unpushed commits) fast-forwards to nothing and is pushed in step 4; one that diverged is refused.
3. Brings the branch up to date with the base: `git merge --no-edit origin/<base>`, or `git rebase origin/<base>` under `update: rebase`. A conflict is aborted and refused, the note holding git's output.
4. Pushes the branch when it is not at the pull request's head (`git push`, or `git push --force-with-lease` after a rebase), so the pull request's head is the revision about to be verified.
5. Runs the verify commands in order. The first failure refuses the merge.
6. Records the note (below) on the phase bead.
7. Reads the pull request's head and the base on the remote (`git ls-remote`) again. When the head is still the verified revision and the base has not moved, merges with `gh pr merge <number> --<method> --match-head-commit <revision>`, so GitHub too refuses a head that moved in between, then deletes the remote branch (`git push origin --delete kitchen/<order>`). A delete that fails, as when GitHub deleted the branch itself on the merge, is said in the note and on standard error and is not a refusal: the pull request is merged. When the head or the base moved, the note says which and the helper verifies again from step 2, at most three times; a head or base that keeps moving is refused.

A verified revision is evidence for that revision only: every verify leaves its own note, and no merge happens on a note older than the pull request's head or the base.

## The note

Every outcome after the pull request is known is appended to the notes of the phase bead and names the revision and the base, so the audit connects the evidence to what was merged; a refusal from git or gh itself (a fetch or a push that fails) names the revision and base last read:

```
merge gate: verified
revision: ddd4444
base: ccc3333
at: 2026-01-01T00:00:00.000Z
$ npm run typecheck
exit 0
$ npm test
42 passing
exit 0
```

The first line is one of:

| Line | Meaning |
| --- | --- |
| `merge gate: verified` | Every command exited 0 on `revision` with the base at `base`. |
| `merge gate: refused, <command> exited <n>` | The command failed; the note ends with its output and exit code. The commands after it did not run. |
| `merge gate: refused, the merge of origin/<base> conflicted` (or `the rebase onto`) | The update did not apply; the note holds git's output. `revision` is the branch as it was. |
| `merge gate: refused, no VERIFY file in the repository` | Nothing was run. |
| `merge gate: refused, the worktree diverged from the pull request head <sha>` | The branch here and the branch pushed do not meet; nothing was run. |
| `merge gate: refused, git ... failed (exit <n>): ...` (or `gh ...`) | A git or gh call failed on its own; the note holds its message and the `revision` and `base` last read. |
| `merge gate: stale, the pull request head moved to <sha> after the verify` | Verified again on the new head. |
| `merge gate: stale, the base moved to <sha> after the verify` | Fetched and verified again. |
| `merge gate: refused, still stale after 3 verifies: <what moved>` | The last verified `revision` and `base` are named; a person decides. |
| `merge gate: merged <url>` | The pull request was merged at `revision` on `base`; the last line says whether the remote branch was deleted. |

The output of a command is kept whole up to 4000 characters; a longer one keeps its tail, with a line saying how much was elided.

## Prior art

Umka's `merge.md` merged with `gh pr merge` and the repository's merge method and deleted the branch, without a verify step; the migrated phase file gains this procedure (spec: Umka migration).
