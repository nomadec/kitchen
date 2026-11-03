// Worktrees per order per repository, exercised through `kitchen up --foreground --once`: scripted git
// answers in; the fetch, the branch check, the worktree add, the identity and hook config and the
// claude working directory out; on tick, the worktrees of closed orders removed and open ones kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { FORWARDED_HOOKS } from "./worktree.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

const EXPEDITOR = ["--actor", "sona/expeditor"];

const PHASE_TEXT = (slug: string) =>
  `---\nphase: ${slug}\nskill: umka:${slug}\nfrom: []\nto: []\nartifact: a PR\nmodel: claude-opus-5\nentry: [ticket]\nbudget:\n  usd: 5\n  effort: high\n---\n# ${slug}\n`;

/** Beneath every table: no gate open, no closed pass to apply, no stale lease to reclaim, and a phase read back after its turn is closed (answers.test.ts and lease.test.ts script the rest). */
const SETTLED: ScriptedAnswer[] = [
  { command: "bd", args: [...EXPEDITOR, "gate", "check", "--json"], stdout: "No open gates found.\n" },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "source"], stdout: "[]" },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "gate"], stdout: "[]" },
  { command: "bd", args: [...EXPEDITOR, "reclaim", "--json"], stdout: '{"count":0,"reclaimed":null,"schema_version":1,"scoped":false}' },
  { command: "bd", args: [...EXPEDITOR, "show"], stdout: '[{"id":"kitchen-21","status":"closed","issue_type":"task"}]' },
];

/** A host whose station checks out two repositories under its home. */
function kitchen(t: { after(fn: () => void): void }, table: (checkouts: { kitchen: string; sona: string }) => readonly ScriptedAnswer[]) {
  // The checkouts live under the host's home, which exists only once the host does; the fake runner
  // reads its table at call time, so the rows are added after.
  const rows: ScriptedAnswer[] = [];
  const host = initialisedHost(t, rows);
  const checkouts = { kitchen: path.join(host.home, "src", "kitchen"), sona: path.join(host.home, "src", "sona") };
  rows.push(...table(checkouts), ...SETTLED);
  const run = () => main(["up", "--foreground", "--once"], host.deps);
  const git = () => host.runner.calls.filter((c) => c.argv[0] === "git").map((c) => c.argv.slice(1));
  const claude = () => host.runner.calls.filter((c) => c.argv[0] === "claude");
  const logFile = path.join(host.home, ".local", "state", "kitchen", "expeditor.jsonl");
  const log = (): Record<string, unknown>[] =>
    fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...host, checkouts, run, git, claude, log };
}

const station = (checkouts: { kitchen: string; sona: string }, options: { worktrees?: string } = {}) => ({
  id: "kitchen-10", title: "sona/oven", status: "open", issue_type: "station",
  labels: ["owner:sona", "host:sona-laptop", "cap:2"],
  notes: `offers: nomadec/kitchen and sona-is/sona checked out\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models: ["claude-opus-5"], auth: "subscription", plugins: [], skills: [],
    repositories: [{ slug: "nomadec/kitchen", path: checkouts.kitchen }, { slug: "sona-is/sona", path: checkouts.sona }],
    worktrees: options.worktrees ?? "per-order", cap: 2, budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [],
  })}\n\`\`\``,
});

const phase = (id: string, order: string) => ({
  id, title: "reproduce: Stale cookie", status: "open", issue_type: "task", parent: order, assignee: "sona/oven",
  labels: ["phase:reproduce", "station:sona/oven"], notes: "model: claude-opus-5", description: PHASE_TEXT("reproduce"),
});

const order = (id: string, repos: string, status = "in_progress") => ({
  id, title: "Stale cookie", status, issue_type: "epic", labels: ["loop"], assignee: status === "in_progress" ? "sona/oven" : undefined,
  notes: `repos: ${repos}\nrecipe: umka rev:a1b2c3d\nclass: bug`,
});

/** The bd answers of one tick that starts one turn on kitchen-21 of order kitchen-20. */
const oneTurn = (checkouts: { kitchen: string; sona: string }, repos: string, options: { worktrees?: string } = {}): ScriptedAnswer[] => [
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "station"], stdout: JSON.stringify([station(checkouts, options)]) },
  { command: "bd", args: [...EXPEDITOR, "ready", "--assignee", "sona/oven"], stdout: JSON.stringify([phase("kitchen-21", "kitchen-20")]) },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--status", "in_progress"], stdout: "[]" },
  { command: "bd", args: [...EXPEDITOR, "list", "--assignee", "sona/oven", "--status", "in_progress"], stdout: "[]" },
  { command: "bd", args: ["--actor", "sona/oven", "update", "kitchen-20", "--claim"], stdout: JSON.stringify([order("kitchen-20", repos)]) },
  { command: "bd", args: ["--actor", "sona/oven", "update", "kitchen-21", "--claim"], stdout: JSON.stringify([{ id: "kitchen-21", status: "in_progress", assignee: "sona/oven" }]) },
  { command: "claude", args: [], stdout: "kitchen-21 closed\n" },
  { command: "bd", args: [...EXPEDITOR, "comments", "add", "kitchen-21"], stdout: "{}" },
  { command: "bd", args: ["--actor", "sona/oven", "update", "kitchen-20", "--status", "open"], stdout: "[]" },
];

/** The git answers of a checkout whose remote has no `kitchen/<order>` branch yet, on `main`. */
const fresh = (checkout: string, order: string): ScriptedAnswer[] => [
  { command: "git", args: ["-C", checkout, "fetch", "origin"] },
  { command: "git", args: ["-C", checkout, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/kitchen/${order}`], exitCode: 1 },
  { command: "git", args: ["-C", checkout, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], stdout: "origin/main\n" },
  { command: "git", args: ["-C", checkout, "worktree", "add"] },
  { command: "git", args: ["-C", checkout, "config", "extensions.worktreeConfig", "true"] },
  { command: "git", args: ["-C", path.join(checkout, ".kitchen", "worktrees", order), "config", "--worktree"] },
];

/** The git answers of a checkout whose remote carries `kitchen/<order>` from another host's turn. */
const handedOff = (checkout: string, order: string): ScriptedAnswer[] => [
  { command: "git", args: ["-C", checkout, "fetch", "origin"] },
  { command: "git", args: ["-C", checkout, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/kitchen/${order}`], stdout: "0123abc\n" },
  { command: "git", args: ["-C", checkout, "worktree", "add"] },
  { command: "git", args: ["-C", checkout, "config", "extensions.worktreeConfig", "true"] },
  { command: "git", args: ["-C", path.join(checkout, ".kitchen", "worktrees", order), "config", "--worktree"] },
];

test("a phase of an order naming a repository whose remote has no kitchen/<order> branch gets a worktree branched from the checkout's upstream, and claude runs in it", async (t) => {
  const k = kitchen(t, (c) => [...oneTurn(c, "nomadec/kitchen"), ...fresh(c.kitchen, "kitchen-20")]);
  const worktree = path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-20");

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.git(), [
    ["-C", k.checkouts.kitchen, "fetch", "origin"],
    ["-C", k.checkouts.kitchen, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/kitchen/kitchen-20"],
    ["-C", k.checkouts.kitchen, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    ["-C", k.checkouts.kitchen, "worktree", "add", "-b", "kitchen/kitchen-20", worktree, "origin/main"],
    ["-C", k.checkouts.kitchen, "config", "extensions.worktreeConfig", "true"],
    ["-C", worktree, "config", "--worktree", "user.name", "sona"],
    ["-C", worktree, "config", "--worktree", "kitchen.station", "sona/oven"],
    ["-C", worktree, "config", "--worktree", "core.hooksPath", path.join(k.checkouts.kitchen, ".kitchen", "hooks")],
  ]);
  assert.equal(k.claude()[0]?.cwd, worktree);
  const sequence = k.runner.calls.map((c) => c.argv).flatMap((argv) => (argv[0] === "claude" ? ["claude"] : argv[0] === "git" ? ["git"] : argv[3] === "update" ? ["take"] : []));
  assert.deepEqual(sequence.slice(0, 11), ["take", "git", "git", "git", "git", "git", "git", "git", "git", "take", "claude"], "the worktrees are prepared between the take, which answers the order's repositories, and the claim");
});

test("the remote kitchen/<order> branch, when it exists, is checked out as the worktree's branch, so a handoff from another host continues from the same commits", async (t) => {
  const k = kitchen(t, (c) => [...oneTurn(c, "nomadec/kitchen"), ...handedOff(c.kitchen, "kitchen-20")]);
  const worktree = path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-20");

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.git().slice(0, 3), [
    ["-C", k.checkouts.kitchen, "fetch", "origin"],
    ["-C", k.checkouts.kitchen, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/kitchen/kitchen-20"],
    ["-C", k.checkouts.kitchen, "worktree", "add", "--track", "-b", "kitchen/kitchen-20", worktree, "origin/kitchen/kitchen-20"],
  ]);
  assert.ok(!k.git().some((argv) => argv.includes("@{upstream}")), "the base branch is not consulted");
  assert.equal(k.claude()[0]?.cwd, worktree);
});

test("the hooks directory is written under the checkout with every client-side hook, each executable and forwarding to the repository's own hook of that name; prepare-commit-msg then adds Kitchen-Station from the worktree's config", async (t) => {
  const k = kitchen(t, (c) => [...oneTurn(c, "nomadec/kitchen"), ...fresh(c.kitchen, "kitchen-20")]);

  assert.equal(await k.run(), 0, k.err.join(""));

  const dir = path.join(k.checkouts.kitchen, ".kitchen", "hooks");
  assert.deepEqual(fs.readdirSync(dir).sort(), [...FORWARDED_HOOKS].sort());
  for (const name of ["pre-commit", "commit-msg", "pre-push"]) {
    const hook = path.join(dir, name);
    assert.ok(fs.statSync(hook).mode & 0o100, `${name} is executable by its owner`);
    const text = fs.readFileSync(hook, "utf8");
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.match(text, /git config --file "\$common\/config" core\.hooksPath .* --global core\.hooksPath .* --system core\.hooksPath .* echo "\$common\/hooks"/, "the repository's own hooks directory: its core.hooksPath, then the global one, then the system one");
    assert.doesNotMatch(text, /case "\$hooks"/, "a relative core.hooksPath stays relative to the working tree root git runs the hook from");
    assert.match(text, /"\$hooks\/\$name" "\$@" \|\| exit \$\?/, "the repository's hook of the same name runs, and its refusal is the worktree's");
    assert.doesNotMatch(text, /interpret-trailers/);
  }
  const text = fs.readFileSync(path.join(dir, "prepare-commit-msg"), "utf8");
  assert.match(text, /"\$hooks\/\$name" "\$@"/);
  assert.match(text, /git config kitchen\.station/);
  assert.match(text, /interpret-trailers .*--trailer "Kitchen-Station: \$station"/);
});

test("one order whose cleanup fails (its bead gone, or git refusing the removal) is logged under the worktrees step and the tick goes on: the other orders are cleaned and the ready phases dispatched", async (t) => {
  const k = kitchen(t, (c) => [
    { command: "bd", args: [...EXPEDITOR, "list", "--type", "station"], stdout: JSON.stringify([station(c)]) },
    { command: "bd", args: [...EXPEDITOR, "show", "kitchen-20"], stdout: "", stderr: "Error: issue not found: kitchen-20\n", exitCode: 1 },
    { command: "bd", args: [...EXPEDITOR, "show", "kitchen-30"], stdout: JSON.stringify([order("kitchen-30", "nomadec/kitchen", "closed")]) },
    { command: "git", args: ["-C", c.kitchen, "worktree", "remove"], stderr: "fatal: cannot remove a locked working tree\n", exitCode: 128, once: true },
    { command: "bd", args: [...EXPEDITOR, "show", "kitchen-40"], stdout: JSON.stringify([order("kitchen-40", "nomadec/kitchen", "closed")]) },
    { command: "git", args: ["-C", c.kitchen, "worktree", "remove"] },
    { command: "git", args: ["-C", c.kitchen, "branch", "-D"] },
    { command: "bd", args: [...EXPEDITOR, "ready", "--assignee", "sona/oven"], stdout: "[]" },
    { command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--status", "in_progress"], stdout: "[]" },
    { command: "bd", args: [...EXPEDITOR, "list", "--assignee", "sona/oven", "--status", "in_progress"], stdout: "[]" },
  ]);
  for (const id of ["kitchen-20", "kitchen-30", "kitchen-40"]) fs.mkdirSync(path.join(k.checkouts.kitchen, ".kitchen", "worktrees", id), { recursive: true });

  assert.equal(await k.run(), 0, k.err.join(""));

  const failed = k.log().filter((l) => l.step === "worktrees" && l.failed).map((l) => [String(l.order), String(l.failed)]);
  assert.equal(failed.length, 2);
  assert.deepEqual(failed[0]?.[0], "kitchen-20");
  assert.match(failed[0]?.[1] ?? "", /show kitchen-20 --json failed \(exit 1\): Error: issue not found/);
  assert.deepEqual(failed[1]?.[0], "kitchen-30");
  assert.match(failed[1]?.[1] ?? "", /worktree remove --force \S+ failed \(exit 128\): fatal: cannot remove a locked working tree/);
  const line = k.log().find((l) => l.step === "worktrees" && l.removed);
  assert.deepEqual(line?.removed, [path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-40")]);
  assert.ok(k.log().some((l) => l.step === "dispatch"), "the tick ran to its end");
});

test("an order naming two repositories gets two worktrees, each under its station checkout, and claude runs in the first repository's", async (t) => {
  const k = kitchen(t, (c) => [...oneTurn(c, "sona-is/sona, nomadec/kitchen"), ...fresh(c.sona, "kitchen-20"), ...handedOff(c.kitchen, "kitchen-20")]);

  assert.equal(await k.run(), 0, k.err.join(""));

  const adds = k.git().filter((argv) => argv[2] === "worktree");
  assert.deepEqual(adds, [
    ["-C", k.checkouts.sona, "worktree", "add", "-b", "kitchen/kitchen-20", path.join(k.checkouts.sona, ".kitchen", "worktrees", "kitchen-20"), "origin/main"],
    ["-C", k.checkouts.kitchen, "worktree", "add", "--track", "-b", "kitchen/kitchen-20", path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-20"), "origin/kitchen/kitchen-20"],
  ]);
  assert.equal(k.claude()[0]?.cwd, path.join(k.checkouts.sona, ".kitchen", "worktrees", "kitchen-20"));
  assert.deepEqual(k.log().find((line) => line.step === "dispatch" && line.phase === "kitchen-21")?.worktrees, [
    path.join(k.checkouts.sona, ".kitchen", "worktrees", "kitchen-20"),
    path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-20"),
  ]);
});

test("a worktree that exists already is reused: the remote branch is fetched and fast-forwarded into it, nothing is added and the identity is not configured again", async (t) => {
  const k = kitchen(t, (c) => [
    ...oneTurn(c, "nomadec/kitchen"),
    // The tick's cleanup reads the order the existing worktree belongs to: open, so it is kept.
    { command: "bd", args: [...EXPEDITOR, "show", "kitchen-20"], stdout: JSON.stringify([order("kitchen-20", "nomadec/kitchen")]) },
    { command: "git", args: ["-C", c.kitchen, "fetch", "origin"] },
    { command: "git", args: ["-C", c.kitchen, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/kitchen/kitchen-20"], stdout: "0123abc\n" },
    { command: "git", args: ["-C", path.join(c.kitchen, ".kitchen", "worktrees", "kitchen-20"), "merge", "--ff-only"] },
  ]);
  const worktree = path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-20");
  fs.mkdirSync(worktree, { recursive: true });

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.git(), [
    ["-C", k.checkouts.kitchen, "fetch", "origin"],
    ["-C", k.checkouts.kitchen, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/kitchen/kitchen-20"],
    ["-C", worktree, "merge", "--ff-only", "origin/kitchen/kitchen-20"],
  ]);
  assert.equal(k.claude()[0]?.cwd, worktree);
  assert.ok(fs.existsSync(path.join(k.checkouts.kitchen, ".kitchen", "hooks", "pre-commit")), "the forwarding hooks are written on reuse too, so a worktree made by an earlier version forwards what this one does");
});

test("an order naming no repository, or a station whose worktree policy is not per-order, runs claude in the station's checkout with no git call", async (t) => {
  const none = kitchen(t, (c) => oneTurn(c, ""));
  assert.equal(await none.run(), 0, none.err.join(""));
  assert.deepEqual(none.git(), []);
  assert.equal(none.claude()[0]?.cwd, none.checkouts.kitchen);

  const shared = kitchen(t, (c) => oneTurn(c, "nomadec/kitchen", { worktrees: "shared" }));
  assert.equal(await shared.run(), 0, shared.err.join(""));
  assert.deepEqual(shared.git(), []);
  assert.equal(shared.claude()[0]?.cwd, shared.checkouts.kitchen);
});

test("a fetch that fails drops the phase with git's reason: the take is released, the phase is not claimed and no claude call is made", async (t) => {
  const k = kitchen(t, (c) => [
    ...oneTurn(c, "nomadec/kitchen"),
    { command: "git", args: ["-C", c.kitchen, "fetch", "origin"], stderr: "fatal: unable to access 'https://github.com/nomadec/kitchen/': Could not resolve host\n", exitCode: 128 },
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 0);
  const writes = k.runner.calls.filter((c) => c.argv[0] === "bd" && c.argv[3] === "update").map((c) => c.argv.slice(3));
  assert.deepEqual(writes, [
    ["update", "kitchen-20", "--claim", "--json"],
    ["update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ], "the take, then its release; no claim");
  const dropped = k.log().find((line) => line.step === "dispatch" && line.dropped);
  assert.match(String(dropped?.dropped), /^git -C \S+ fetch origin failed \(exit 128\): fatal: unable to access/);
});

test("on tick, the worktrees of closed orders under this host's checkouts are removed with their branches, and an open order's are kept", async (t) => {
  const k = kitchen(t, (c) => [
    { command: "bd", args: [...EXPEDITOR, "list", "--type", "station"], stdout: JSON.stringify([station(c)]) },
    { command: "bd", args: [...EXPEDITOR, "show", "kitchen-20"], stdout: JSON.stringify([order("kitchen-20", "nomadec/kitchen, sona-is/sona", "closed")]) },
    { command: "bd", args: [...EXPEDITOR, "show", "kitchen-30"], stdout: JSON.stringify([order("kitchen-30", "nomadec/kitchen")]) },
    { command: "git", args: ["-C", c.kitchen, "worktree", "remove"] },
    { command: "git", args: ["-C", c.kitchen, "branch", "-D"] },
    { command: "git", args: ["-C", c.sona, "worktree", "remove"] },
    { command: "git", args: ["-C", c.sona, "branch", "-D"] },
    { command: "bd", args: [...EXPEDITOR, "ready", "--assignee", "sona/oven"], stdout: "[]" },
    { command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--status", "in_progress"], stdout: "[]" },
    { command: "bd", args: [...EXPEDITOR, "list", "--assignee", "sona/oven", "--status", "in_progress"], stdout: "[]" },
  ]);
  for (const [checkout, orders] of [[k.checkouts.kitchen, ["kitchen-20", "kitchen-30"]], [k.checkouts.sona, ["kitchen-20"]]] as const) {
    for (const id of orders) fs.mkdirSync(path.join(checkout, ".kitchen", "worktrees", id), { recursive: true });
  }

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.git(), [
    ["-C", k.checkouts.kitchen, "worktree", "remove", "--force", path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-20")],
    ["-C", k.checkouts.kitchen, "branch", "-D", "kitchen/kitchen-20"],
    ["-C", k.checkouts.sona, "worktree", "remove", "--force", path.join(k.checkouts.sona, ".kitchen", "worktrees", "kitchen-20")],
    ["-C", k.checkouts.sona, "branch", "-D", "kitchen/kitchen-20"],
  ]);
  const shows = k.runner.calls.filter((c) => c.argv[3] === "show").map((c) => c.argv[4]);
  assert.deepEqual(shows, ["kitchen-20", "kitchen-30"], "each order is read once, however many checkouts hold it");
  const line = k.log().find((l) => l.step === "worktrees");
  assert.deepEqual({ removed: line?.removed, kept: line?.kept }, {
    removed: [path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-20"), path.join(k.checkouts.sona, ".kitchen", "worktrees", "kitchen-20")],
    kept: [path.join(k.checkouts.kitchen, ".kitchen", "worktrees", "kitchen-30")],
  });
});
