// The merge gate, exercised through the helper's entry from an order's worktree: a VERIFY file in the
// worktree and scripted git, gh and command answers in; the fetch, the update from the base, the verify
// commands in order, the note on the phase bead, and the merge only of the verified revision out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeGate } from "./merge-gate.ts";
import { initialisedHost } from "./testing/index.ts";
import type { ScriptedAnswer } from "./testing/index.ts";

const OVEN = ["--actor", "sona/oven"];
const ORDER = "kitchen-20";
const PHASE = "kitchen-23";
const BRANCH = `kitchen/${ORDER}`;
const PR = { number: 7, url: "https://github.com/nomadec/kitchen/pull/7", state: "OPEN", baseRefName: "main", headRefName: BRANCH, headRefOid: "aaa1111" };

/** A host in a session the oven station started, with the order's worktree holding a VERIFY file. */
function worktree(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], verify: string | false = "npm test\nnpm run typecheck\n") {
  const host = initialisedHost(t, table, { sessionEnv: { BEADS_ACTOR: "sona/oven" } });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-worktree-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  if (verify !== false) fs.writeFileSync(path.join(cwd, "VERIFY"), verify);
  const run = (...argv: string[]) => mergeGate(argv, { ...host.deps, cwd });
  const calls = (command: string) => host.runner.calls.filter((c) => c.argv[0] === command);
  const argv = (command: string) => calls(command).map((c) => c.argv.slice(1));
  /** The text of every note the gate appended to the phase bead, in order. */
  const notes = () => argv("bd").filter((a) => a[2] === "update" && a[4] === "--append-notes").map((a) => a[5] ?? "");
  return { ...host, cwd, run, calls, argv, notes };
}

const shown = (): ScriptedAnswer => ({ command: "bd", args: [...OVEN, "show", PHASE], stdout: JSON.stringify([{ id: PHASE, title: "merge: Stale cookie", status: "in_progress", issue_type: "task", parent: ORDER }]) });
const noted = (): ScriptedAnswer => ({ command: "bd", args: [...OVEN, "update", PHASE, "--append-notes"], stdout: "[]" });
const onBranch = (cwd: string): ScriptedAnswer => ({ command: "git", args: ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], stdout: `${BRANCH}\n` });
const pullRequest = (pr: object = PR): ScriptedAnswer => ({ command: "gh", args: ["pr", "view", "--json", "number,url,state,baseRefName,headRefName,headRefOid"], stdout: JSON.stringify(pr) });
const fetched = (cwd: string): ScriptedAnswer => ({ command: "git", args: ["-C", cwd, "fetch", "origin"] });
const baseAt = (cwd: string, sha: string, once = false): ScriptedAnswer => ({ command: "git", args: ["-C", cwd, "rev-parse", "origin/main"], stdout: `${sha}\n`, once });
const merged = (cwd: string, answer: Partial<ScriptedAnswer> = {}): ScriptedAnswer => ({ command: "git", args: ["-C", cwd, "merge", "--no-edit", "origin/main"], stdout: "Already up to date.\n", ...answer });
const headAt = (cwd: string, sha: string, once = false): ScriptedAnswer => ({ command: "git", args: ["-C", cwd, "rev-parse", "HEAD"], stdout: `${sha}\n`, once });
const pushed = (cwd: string): ScriptedAnswer => ({ command: "git", args: ["-C", cwd, "push"] });
const command = (line: string, answer: Partial<ScriptedAnswer> = {}): ScriptedAnswer => ({ command: "sh", args: ["-c", line], stdout: `${line} ran\n`, ...answer });
const prHeadAt = (sha: string, once = false): ScriptedAnswer => ({ command: "gh", args: ["pr", "view", "--json", "headRefOid,state"], stdout: JSON.stringify({ headRefOid: sha, state: "OPEN" }), once });
const remoteBaseAt = (cwd: string, sha: string, once = false): ScriptedAnswer => ({ command: "git", args: ["-C", cwd, "ls-remote", "origin", "refs/heads/main"], stdout: `${sha}\trefs/heads/main\n`, once });
const prMerged = (): ScriptedAnswer => ({ command: "gh", args: ["pr", "merge", "7"] });
const branchDeleted = (cwd: string): ScriptedAnswer => ({ command: "git", args: ["-C", cwd, "push", "origin", "--delete", BRANCH] });

/** The answers of a gate whose branch is up to date with the base and whose head and base stay put. */
const steady = (cwd: string): ScriptedAnswer[] => [
  shown(), noted(), onBranch(cwd), pullRequest(), fetched(cwd), baseAt(cwd, "bbb2222"), merged(cwd), headAt(cwd, "aaa1111"),
  command("npm test"), command("npm run typecheck"), prHeadAt("aaa1111"), remoteBaseAt(cwd, "bbb2222"), prMerged(), branchDeleted(cwd),
];

test("an unchanged head and base after a green verify lead straight to the merge of the verified revision, then the remote branch is deleted", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(...steady(w.cwd));

  assert.equal(await w.run(PHASE), 0, w.err.join(""));

  assert.deepEqual(w.argv("git"), [
    ["-C", w.cwd, "rev-parse", "--abbrev-ref", "HEAD"],
    ["-C", w.cwd, "fetch", "origin"],
    ["-C", w.cwd, "rev-parse", "origin/main"],
    ["-C", w.cwd, "rev-parse", "HEAD"],
    ["-C", w.cwd, "merge", "--no-edit", "origin/main"],
    ["-C", w.cwd, "rev-parse", "HEAD"],
    ["-C", w.cwd, "ls-remote", "origin", "refs/heads/main"],
    ["-C", w.cwd, "push", "origin", "--delete", BRANCH],
  ], "the branch is at the PR head and up to date with the base already, so nothing is fast-forwarded or pushed before the verify");
  assert.deepEqual(w.argv("sh"), [["-c", "npm test"], ["-c", "npm run typecheck"]], "the verify commands run in the file's order");
  assert.ok(w.calls("sh").every((c) => c.cwd === w.cwd), "each command runs in the worktree");
  assert.deepEqual(w.argv("gh"), [
    ["pr", "view", "--json", "number,url,state,baseRefName,headRefName,headRefOid"],
    ["pr", "view", "--json", "headRefOid,state"],
    ["pr", "merge", "7", "--merge", "--match-head-commit", "aaa1111"],
  ]);
  assert.ok(w.calls("gh").every((c) => c.cwd === w.cwd), "gh resolves the pull request from the worktree's branch");
  const [verified, mergedNote] = w.notes();
  assert.match(verified ?? "", /^merge gate: verified\n/);
  assert.match(verified ?? "", /\nrevision: aaa1111\n/);
  assert.match(verified ?? "", /\nbase: bbb2222\n/);
  assert.match(verified ?? "", /\$ npm test\nnpm test ran\nexit 0\n/);
  assert.match(verified ?? "", /\$ npm run typecheck\nnpm run typecheck ran\nexit 0/);
  assert.match(mergedNote ?? "", /^merge gate: merged https:\/\/github.com\/nomadec\/kitchen\/pull\/7\nrevision: aaa1111\nbase: bbb2222\nat: 2026-01-01T00:00:00.000Z\nremote branch kitchen\/kitchen-20 deleted$/);
  assert.equal(w.notes().length, 2);
  assert.ok(w.argv("bd").every((a) => a[0] === "--actor" && a[1] === "sona/oven"), "every bd write carries the session's actor");
  assert.match(w.out.join(""), /merged https:\/\/github.com\/nomadec\/kitchen\/pull\/7 at aaa1111/);
});

test("a failing verify command refuses the merge; the note names the command, its output and the revisions, and the commands after it do not run", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(
    shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd), baseAt(w.cwd, "bbb2222"), merged(w.cwd), headAt(w.cwd, "aaa1111"),
    command("npm test", { stdout: "1 passing\n1 failing\n", stderr: "AssertionError: stale cookie\n", exitCode: 1 }),
    command("npm run typecheck"),
  );

  assert.equal(await w.run(PHASE), 1);

  assert.deepEqual(w.argv("sh"), [["-c", "npm test"]], "the first failure stops the run");
  assert.ok(!w.argv("gh").some((a) => a[1] === "merge"), "no merge");
  const [note] = w.notes();
  assert.match(note ?? "", /^merge gate: refused, npm test exited 1\n/);
  assert.match(note ?? "", /\nrevision: aaa1111\nbase: bbb2222\n/);
  assert.match(note ?? "", /\$ npm test\n1 passing\n1 failing\nAssertionError: stale cookie\nexit 1/);
  assert.equal(w.notes().length, 1);
  assert.match(w.err.join(""), /refused, npm test exited 1/);
});

test("a base that moved after the verify is fetched and verified again before the merge, and each verify leaves its own note", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(
    shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd),
    baseAt(w.cwd, "bbb2222", true), baseAt(w.cwd, "ccc3333"),
    merged(w.cwd, { once: true }), merged(w.cwd, { stdout: "Merge made by the 'ort' strategy.\n" }),
    // HEAD is read before and after each update: aaa1111 through the first round and before the second update, then the merge commit.
    headAt(w.cwd, "aaa1111", true), headAt(w.cwd, "aaa1111", true), headAt(w.cwd, "aaa1111", true), headAt(w.cwd, "ddd4444"),
    pushed(w.cwd),
    command("npm test"), command("npm run typecheck"),
    prHeadAt("aaa1111", true), prHeadAt("ddd4444"),
    remoteBaseAt(w.cwd, "ccc3333"),
    prMerged(), branchDeleted(w.cwd),
  );

  assert.equal(await w.run(PHASE), 0, w.err.join(""));

  assert.deepEqual(w.argv("sh"), [["-c", "npm test"], ["-c", "npm run typecheck"], ["-c", "npm test"], ["-c", "npm run typecheck"]], "verified twice");
  assert.deepEqual(w.argv("git").filter((a) => a[2] === "fetch" || a[2] === "push"), [
    ["-C", w.cwd, "fetch", "origin"],
    ["-C", w.cwd, "fetch", "origin"],
    ["-C", w.cwd, "push", "origin", BRANCH],
    ["-C", w.cwd, "push", "origin", "--delete", BRANCH],
  ], "the second round brings the moved base in and pushes the merge commit, so the PR head is the verified revision");
  assert.deepEqual(w.argv("gh").at(-1), ["pr", "merge", "7", "--merge", "--match-head-commit", "ddd4444"]);
  const notes = w.notes();
  assert.equal(notes.length, 4, notes.join("\n---\n"));
  assert.match(notes[0] ?? "", /^merge gate: verified\nrevision: aaa1111\nbase: bbb2222\n/);
  assert.match(notes[1] ?? "", /^merge gate: stale, the base moved to ccc3333 after the verify\nrevision: aaa1111\nbase: bbb2222\n/);
  assert.match(notes[2] ?? "", /^merge gate: verified\nrevision: ddd4444\nbase: ccc3333\n/);
  assert.match(notes[3] ?? "", /^merge gate: merged .*\nrevision: ddd4444\nbase: ccc3333/);
});

test("a PR head that moved after the verify is fast-forwarded into the worktree and verified again: the earlier verify is evidence for its revision only", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(
    shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd), baseAt(w.cwd, "bbb2222"), merged(w.cwd),
    // HEAD is read before and after each update: aaa1111 through the first round and before the second update, then the pushed head.
    headAt(w.cwd, "aaa1111", true), headAt(w.cwd, "aaa1111", true), headAt(w.cwd, "aaa1111", true), headAt(w.cwd, "eee5555"),
    { command: "git", args: ["-C", w.cwd, "merge", "--ff-only", `origin/${BRANCH}`] },
    command("npm test"), command("npm run typecheck"),
    prHeadAt("eee5555"),
    remoteBaseAt(w.cwd, "bbb2222"),
    prMerged(), branchDeleted(w.cwd),
  );

  assert.equal(await w.run(PHASE), 0, w.err.join(""));

  assert.equal(w.argv("sh").length, 4, "verified twice");
  assert.deepEqual(w.argv("git").filter((a) => a[2] === "merge" || a[2] === "push"), [
    ["-C", w.cwd, "merge", "--no-edit", "origin/main"],
    ["-C", w.cwd, "merge", "--ff-only", `origin/${BRANCH}`],
    ["-C", w.cwd, "merge", "--no-edit", "origin/main"],
    ["-C", w.cwd, "push", "origin", "--delete", BRANCH],
  ], "the second round fast-forwards to what was pushed and pushes nothing itself");
  assert.match(w.notes()[1] ?? "", /^merge gate: stale, the pull request head moved to eee5555 after the verify\nrevision: aaa1111\nbase: bbb2222\n/);
  assert.match(w.notes()[2] ?? "", /^merge gate: verified\nrevision: eee5555\nbase: bbb2222\n/);
  assert.deepEqual(w.argv("gh").at(-1), ["pr", "merge", "7", "--merge", "--match-head-commit", "eee5555"]);
});

test("a base that keeps moving is refused after three rounds, the note naming the last verified revision and base", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(
    shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd),
    baseAt(w.cwd, "b1", true), baseAt(w.cwd, "b2", true), baseAt(w.cwd, "b3"),
    merged(w.cwd), headAt(w.cwd, "aaa1111"),
    command("npm test"), command("npm run typecheck"), prHeadAt("aaa1111"),
    remoteBaseAt(w.cwd, "b2", true), remoteBaseAt(w.cwd, "b3", true), remoteBaseAt(w.cwd, "b4"),
  );

  assert.equal(await w.run(PHASE), 1);

  assert.equal(w.argv("sh").length, 6, "three verifies");
  assert.ok(!w.argv("gh").some((a) => a[1] === "merge"), "no merge");
  assert.match(w.notes().at(-1) ?? "", /^merge gate: refused, still stale after 3 verifies: the base moved to b4\nrevision: aaa1111\nbase: b3\n/);
});

test("a worktree that diverged from the pull request head is refused with a note, nothing verified", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(
    shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd), baseAt(w.cwd, "bbb2222"), headAt(w.cwd, "9999999"),
    { command: "git", args: ["-C", w.cwd, "merge", "--ff-only", `origin/${BRANCH}`], stderr: "fatal: Not possible to fast-forward, aborting.\n", exitCode: 128 },
  );

  assert.equal(await w.run(PHASE), 1);

  assert.deepEqual(w.argv("sh"), []);
  const [note] = w.notes();
  assert.match(note ?? "", /^merge gate: refused, the worktree diverged from the pull request head aaa1111\nrevision: aaa1111\nbase: bbb2222\n/);
  assert.match(note ?? "", /\$ git merge --ff-only origin\/kitchen\/kitchen-20\nfatal: Not possible to fast-forward, aborting.\nexit 128$/);
});

test("a git call that fails on its own, such as a refused push, is noted with the revisions last read", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(
    shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd), baseAt(w.cwd, "bbb2222"),
    merged(w.cwd, { stdout: "Merge made by the 'ort' strategy.\n" }),
    headAt(w.cwd, "aaa1111", true), headAt(w.cwd, "ddd4444"),
    { command: "git", args: ["-C", w.cwd, "push", "origin", BRANCH], stderr: "! [rejected] kitchen/kitchen-20 -> kitchen/kitchen-20 (fetch first)\n", exitCode: 1 },
  );

  assert.equal(await w.run(PHASE), 1);

  assert.deepEqual(w.argv("sh"), []);
  assert.match(w.notes()[0] ?? "", /^merge gate: refused, git -C \S+ push origin kitchen\/kitchen-20 failed \(exit 1\): ! \[rejected\].*\nrevision: ddd4444\nbase: bbb2222\n/);
  assert.match(w.err.join(""), /refused, git .* push origin kitchen\/kitchen-20 failed/);
});

test("a merge after which the remote branch is already gone is still a merge, the note saying the branch was not deleted", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(...steady(w.cwd).filter((row) => row.args[2] !== "push"), { command: "git", args: ["-C", w.cwd, "push", "origin", "--delete", BRANCH], stderr: "error: unable to delete 'kitchen/kitchen-20': remote ref does not exist\n", exitCode: 1 });

  assert.equal(await w.run(PHASE), 0, w.err.join(""));

  assert.match(w.notes()[1] ?? "", /^merge gate: merged .*\nrevision: aaa1111\nbase: bbb2222\nat: .*\nremote branch kitchen\/kitchen-20 not deleted: error: unable to delete 'kitchen\/kitchen-20': remote ref does not exist$/);
  assert.match(w.err.join(""), /not deleted/);
});

test("a repository whose VERIFY file says `update: rebase` is rebased onto the base and force-pushed with a lease, and `pr: squash` chooses the squash merge", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows, "# how the branch meets the base\nupdate: rebase\npr: squash\n\nnpm test\n");
  rows.push(
    shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd), baseAt(w.cwd, "bbb2222"),
    { command: "git", args: ["-C", w.cwd, "rebase", "origin/main"] },
    headAt(w.cwd, "aaa1111", true), headAt(w.cwd, "fff6666"), pushed(w.cwd),
    command("npm test"), prHeadAt("fff6666"), remoteBaseAt(w.cwd, "bbb2222"), prMerged(), branchDeleted(w.cwd),
  );

  assert.equal(await w.run(PHASE), 0, w.err.join(""));

  assert.deepEqual(w.argv("git").slice(4, 7), [
    ["-C", w.cwd, "rebase", "origin/main"],
    ["-C", w.cwd, "rev-parse", "HEAD"],
    ["-C", w.cwd, "push", "--force-with-lease", "origin", BRANCH],
  ]);
  assert.deepEqual(w.argv("sh"), [["-c", "npm test"]], "comments, blank lines and directives are not commands");
  assert.deepEqual(w.argv("gh").at(-1), ["pr", "merge", "7", "--squash", "--match-head-commit", "fff6666"]);
});

test("an update that conflicts is aborted and refused, the note naming the revisions that did not meet", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(
    shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd), baseAt(w.cwd, "bbb2222"),
    merged(w.cwd, { stdout: "CONFLICT (content): Merge conflict in src/cli.ts\n", exitCode: 1 }),
    { command: "git", args: ["-C", w.cwd, "merge", "--abort"] },
    headAt(w.cwd, "aaa1111"),
  );

  assert.equal(await w.run(PHASE), 1);

  assert.deepEqual(w.argv("git").slice(3), [
    ["-C", w.cwd, "rev-parse", "HEAD"],
    ["-C", w.cwd, "merge", "--no-edit", "origin/main"],
    ["-C", w.cwd, "merge", "--abort"],
    ["-C", w.cwd, "rev-parse", "HEAD"],
  ]);
  assert.deepEqual(w.argv("sh"), [], "nothing is verified");
  const [note] = w.notes();
  assert.match(note ?? "", /^merge gate: refused, the merge of origin\/main conflicted\nrevision: aaa1111\nbase: bbb2222\n/);
  assert.match(note ?? "", /CONFLICT \(content\): Merge conflict in src\/cli.ts/);
});

test("a repository without a VERIFY file, after the update, is refused with a note, so an unverified branch never merges by omission", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows, false);
  rows.push(shown(), noted(), onBranch(w.cwd), pullRequest(), fetched(w.cwd), baseAt(w.cwd, "bbb2222"), merged(w.cwd), headAt(w.cwd, "aaa1111"));

  assert.equal(await w.run(PHASE), 1);

  assert.deepEqual(w.argv("sh"), [], "nothing runs");
  assert.ok(!w.argv("gh").some((a) => a[1] === "merge"), "no merge");
  assert.match(w.notes()[0] ?? "", /^merge gate: refused, no VERIFY file in the repository\nrevision: aaa1111\nbase: bbb2222/);
  assert.match(w.err.join(""), /no VERIFY file/);
});

test("a branch without an open pull request is refused before any write", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const w = worktree(t, rows);
  rows.push(shown(), onBranch(w.cwd), { command: "gh", args: ["pr", "view"], stderr: "no pull requests found for branch \"kitchen/kitchen-20\"\n", exitCode: 1 });

  assert.equal(await w.run(PHASE), 1);

  assert.equal(w.notes().length, 0);
  assert.match(w.err.join(""), /no pull requests found/);
});

test("a phase id is required", async (t) => {
  const w = worktree(t, []);
  assert.equal(await w.run(), 1);
  assert.match(w.err.join(""), /a phase id is required/);
  assert.equal(w.runner.calls.length, 0);
});
