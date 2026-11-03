// kitchen turn, exercised through the CLI: a scripted phase, the owner's stations and bd ready in; the
// order take, the phase claim and a claude invocation in interactive mode (no print flag, no dollar
// cap, the terminal attached) out, the result line commented on the phase and the order released; and
// the refusals, each before any write.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { HostOptions, ScriptedAnswer } from "../testing/index.ts";

const OWNER = ["--actor", "sona"];
const EXPEDITOR = ["--actor", "sona/expeditor"];
const DESK = ["--actor", "sona/desk"];
const PROMPT = (phase: string) => `Invoke the Skill tool with skill "kitchen:turn" and args "${phase}"`;

/** Beneath every table: the order read back after a closed phase is still open (the session closed the phase, not the order), and the phase read back after the session is closed. The failed-turn test scripts an open phase. */
const ORDER_OPEN_AFTER: ScriptedAnswer = { command: "bd", args: [...EXPEDITOR, "show", "kitchen-20"], stdout: '[{"id":"kitchen-20","status":"in_progress","issue_type":"epic","assignee":"sona/desk"}]' };
const CLOSED_AFTER: ScriptedAnswer = { command: "bd", args: [...EXPEDITOR, "show"], stdout: '[{"id":"kitchen-21","status":"closed","issue_type":"task"}]' };

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], options: HostOptions = {}) {
  // Added to the test's own array, which the fake runner reads at call time, so rows a test pushes after this still count.
  if (!table.includes(CLOSED_AFTER)) (table as ScriptedAnswer[]).push(ORDER_OPEN_AFTER, CLOSED_AFTER);
  const host = initialisedHost(t, table, options);
  const run = (...argv: string[]) => main(["turn", ...argv], host.deps);
  /** Every bd call's argv after `bd`, actor included. */
  const bd = () => host.runner.calls.filter((c) => c.argv[0] === "bd").map((c) => c.argv.slice(1));
  const writes = () => bd().filter((argv) => argv[2] === "update" || argv[2] === "comments");
  const claude = () => host.runner.calls.filter((c) => c.argv[0] === "claude");
  return { ...host, run, bd, writes, claude };
}

const PHASE_TEXT = (slug: string) =>
  `---\nphase: ${slug}\nskill: umka:${slug}\nfrom: []\nto: []\nartifact: a proposal\nmodel: claude-opus-5\nentry: [idea]\nrounds: 3\nbudget:\n  usd: 5\n  effort: high\n---\n# ${slug}\n`;

const station = (id: string, title: string, options: { attended?: boolean; host?: string; plugins?: string[]; repositories?: { slug: string; path: string }[] } = {}) => ({
  id, title, status: "open", issue_type: "station",
  labels: [`owner:${title.split("/")[0]}`, `host:${options.host ?? "sona-laptop"}`, "cap:1", ...(options.attended === false ? [] : ["attended"])],
  notes: `offers: a human at the desk\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models: ["claude-opus-5"], auth: "subscription", plugins: options.plugins ?? [], skills: [],
    repositories: options.repositories ?? [{ slug: "nomadec/kitchen", path: "/home/sona/src/kitchen" }],
    worktrees: "per-order", cap: 1, budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [],
  })}\n\`\`\``,
});

const phase = (id: string, order: string, stationTitle: string, options: { status?: string; assignee?: string; labels?: string[] } = {}) => ({
  id, title: "grill: Stale cookie", status: options.status ?? "open", issue_type: "task", parent: order,
  assignee: options.assignee ?? stationTitle,
  labels: ["phase:grill", `station:${stationTitle}`, "waiting", ...(options.labels ?? [])],
  notes: "model: claude-opus-5",
  description: PHASE_TEXT("grill"),
});

const shown = (bead: { id: string; [field: string]: unknown }): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "show", bead.id], stdout: JSON.stringify([bead]) });
const stations = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "list", "--type", "station", "--label", "owner:sona"], stdout: JSON.stringify(rows) });
const ready = (stationTitle: string, ...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "ready", "--assignee", stationTitle], stdout: JSON.stringify(rows) });
const claimed = (id: string, answer: Partial<ScriptedAnswer> = {}, bead: object = {}): ScriptedAnswer => ({
  command: "bd", args: [...DESK, "update", id, "--claim"], stdout: JSON.stringify([{ id, status: "in_progress", assignee: "sona/desk", ...bead }]), ...answer,
});
const released = (id: string): ScriptedAnswer => ({ command: "bd", args: [...DESK, "update", id, "--status", "open", "--assignee", ""], stdout: "[]" });
const commented = (id: string): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "comments", "add", id], stdout: "{}" });
const session = (stdout = "", exitCode = 0): ScriptedAnswer => ({ command: "claude", args: [], stdout, exitCode });

const GRILL = phase("kitchen-21", "kitchen-20", "sona/desk");

/** The answers of one turn on kitchen-21 of order kitchen-20 at the attended station sona/desk. */
const ONE_TURN: ScriptedAnswer[] = [
  shown(GRILL),
  stations(station("kitchen-10", "sona/desk", { plugins: ["/home/sona/.claude/plugins/umka"] })),
  ready("sona/desk", GRILL),
  claimed("kitchen-20"),
  claimed("kitchen-21"),
  session(),
  commented("kitchen-21"),
  released("kitchen-20"),
];

test("kitchen turn takes the order and claims the phase as the station, then spawns claude interactive: model, plugin directories and effort, no print flag, no dollar cap, no skipped permissions, the terminal attached", async (t) => {
  const k = kitchen(t, ONE_TURN);
  // How many sessions had been spawned when each line was written: the announcement must come before the session owns the terminal.
  const spawnedAtWrite: number[] = [];
  const write = k.deps.stdout;
  k.deps.stdout = (text) => {
    spawnedAtWrite.push(k.claude().length);
    write(text);
  };

  const code = await k.run("kitchen-21");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.writes().slice(0, 2), [
    [...DESK, "update", "kitchen-20", "--claim", "--json"],
    [...DESK, "update", "kitchen-21", "--claim", "--json"],
  ]);
  const [call] = k.claude();
  assert.ok(call, "claude was invoked");
  assert.deepEqual(call.argv, [
    "claude",
    "--model", "claude-opus-5",
    "--plugin-dir", "/opt/kitchen/plugin",
    "--plugin-dir", "/home/sona/.claude/plugins/umka",
    "--effort", "high",
    PROMPT("kitchen-21"),
  ]);
  assert.equal(call.stdio, "inherit", "the session is attached to the human's terminal");
  assert.equal(call.cwd, "/home/sona/src/kitchen", "the station's checkout: the order names no repository");
  assert.deepEqual(call.env, {
    BEADS_ACTOR: "sona/desk",
    BEADS_DIR: path.join(k.configDir, "space", ".beads"),
    BEADS_CREDENTIALS_FILE: "/home/sona/.config/beads/credentials",
  });
  const sequence = k.runner.calls.flatMap((c) => (c.argv[0] === "claude" ? ["claude"] : c.argv[3] === "update" || c.argv[3] === "comments" ? [c.argv.slice(3, 6).join(" ")] : []));
  assert.deepEqual(sequence, ["update kitchen-20 --claim", "update kitchen-21 --claim", "claude", "comments add kitchen-21", "update kitchen-20 --status"], "take, claim, spawn; then the result line and the release");
  for (const call of k.runner.calls.filter((c) => c.argv[0] === "bd")) {
    assert.deepEqual({ cwd: call.cwd, env: call.env }, k.connection);
    assert.equal(call.argv[1], "--actor");
    assert.equal(call.stdio, undefined, "only the session is attached to the terminal");
  }
  assert.match(k.out[0] ?? "", /^Turn on kitchen-21 \(grill: Stale cookie\) at sona\/desk, order kitchen-20: taking the order and claiming the phase as the station\n$/);
  assert.deepEqual(spawnedAtWrite, [0, 1], "the announcement is written before the session is spawned; the end after it");
});

test("the terminal has the session's output, so the result line is its exit; a clean exit is commented as exit 0 and the order is released", async (t) => {
  const k = kitchen(t, ONE_TURN);

  assert.equal(await k.run("kitchen-21"), 0, k.err.join(""));

  assert.deepEqual(k.writes().slice(2), [
    [...EXPEDITOR, "comments", "add", "kitchen-21", "exit 0", "--json"],
    [...DESK, "update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ]);
  assert.match(k.out.at(-1) ?? "", /^Turn ended: exit 0\n$/);
});

test("a session that exits non-zero leaving its phase open is a failed turn: through the shared handling the phase is released by the station and restored by the expeditor with failed:1, the order is released, and kitchen turn exits with the session's code", async (t) => {
  const k = kitchen(t, [
    ...ONE_TURN.slice(0, 5),
    session("", 3),
    commented("kitchen-21"),
    { command: "bd", args: [...EXPEDITOR, "show", "kitchen-21"], stdout: JSON.stringify([{ id: "kitchen-21", title: "grill: Stale cookie", status: "in_progress", issue_type: "task", labels: ["phase:grill", "station:sona/desk"] }]) },
    released("kitchen-21"),
    { command: "bd", args: [...EXPEDITOR, "update", "kitchen-21"], stdout: "[]" },
    released("kitchen-20"),
  ]);

  assert.equal(await k.run("kitchen-21"), 3);

  assert.deepEqual(k.writes().slice(2), [
    [...EXPEDITOR, "comments", "add", "kitchen-21", "exit 3", "--json"],
    [...DESK, "update", "kitchen-21", "--status", "open", "--assignee", "", "--json"],
    [...EXPEDITOR, "update", "kitchen-21", "--add-label", "failed:1", "--assignee", "sona/desk", "--json"],
    [...DESK, "update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ]);
  assert.match(k.err.at(-1) ?? "", /kitchen turn: exit 3: kitchen-21 is a failed turn, failed:1 \(exit 3\)/);
});

test("an order naming a repository the station offers gets its worktree between the take and the claim, and the session runs in it", async (t) => {
  const rows: ScriptedAnswer[] = [];
  const k = kitchen(t, rows);
  const checkout = path.join(k.home, "src", "kitchen");
  const worktree = path.join(checkout, ".kitchen", "worktrees", "kitchen-20");
  rows.push(
    shown(GRILL),
    stations(station("kitchen-10", "sona/desk", { repositories: [{ slug: "nomadec/kitchen", path: checkout }] })),
    ready("sona/desk", GRILL),
    claimed("kitchen-20", {}, { notes: "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: idea" }),
    { command: "git", args: ["-C", checkout, "fetch", "origin"] },
    { command: "git", args: ["-C", checkout, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/kitchen/kitchen-20"], exitCode: 1 },
    { command: "git", args: ["-C", checkout, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], stdout: "origin/main\n" },
    { command: "git", args: ["-C", checkout, "worktree", "add"] },
    { command: "git", args: ["-C", checkout, "config", "extensions.worktreeConfig", "true"] },
    { command: "git", args: ["-C", worktree, "config", "--worktree"] },
    claimed("kitchen-21"),
    session(),
    commented("kitchen-21"),
    released("kitchen-20"),
  );

  assert.equal(await k.run("kitchen-21"), 0, k.err.join(""));

  const sequence = k.runner.calls.map((c) => (c.argv[0] === "git" ? `git ${c.argv[3]}` : c.argv[0] === "claude" ? "claude" : c.argv[3] === "update" ? `update ${c.argv[4]}` : c.argv[3]));
  assert.deepEqual(sequence.slice(3), ["update kitchen-20", "git fetch", "git rev-parse", "git rev-parse", "git worktree", "git config", "git config", "git config", "git config", "update kitchen-21", "claude", "comments", "show", "show", "update kitchen-20"]);
  assert.equal(k.claude()[0]?.cwd, worktree);
  assert.equal(k.claude()[0]?.stdio, "inherit");
});

test("a phase on an unattended station is refused: the expeditor starts it", async (t) => {
  const k = kitchen(t, [shown(phase("kitchen-21", "kitchen-20", "sona/oven")), stations(station("kitchen-10", "sona/oven", { attended: false }))]);

  assert.equal(await k.run("kitchen-21"), 1);

  assert.match(k.err.at(-1) ?? "", /kitchen turn: kitchen-21 is assigned to sona\/oven, an unattended station: the expeditor starts its turns/);
  assert.equal(k.writes().length, 0);
  assert.equal(k.claude().length, 0);
});

test("a phase on a station of this owner on another host, or on another owner's station, is refused naming where it is", async (t) => {
  const elsewhere = kitchen(t, [shown(phase("kitchen-21", "kitchen-20", "sona/mac")), stations(station("kitchen-10", "sona/desk"), station("kitchen-12", "sona/mac", { host: "sona-mac" }))]);
  assert.equal(await elsewhere.run("kitchen-21"), 1);
  assert.match(elsewhere.err.at(-1) ?? "", /kitchen turn: kitchen-21 is assigned to sona\/mac on host sona-mac, not this host \(sona-laptop\)/);

  const theirs = kitchen(t, [shown(phase("kitchen-21", "kitchen-20", "raffy/desk")), stations(station("kitchen-10", "sona/desk"))]);
  assert.equal(await theirs.run("kitchen-21"), 1);
  assert.match(theirs.err.at(-1) ?? "", /kitchen turn: kitchen-21 is assigned to raffy\/desk, not a station of sona/);

  for (const k of [elsewhere, theirs]) {
    assert.equal(k.writes().length, 0);
    assert.equal(k.claude().length, 0);
  }
});

test("a phase held by another turn (claimed, in progress) is refused naming the holder; a closed one is refused too", async (t) => {
  const held = kitchen(t, [shown(phase("kitchen-21", "kitchen-20", "sona/desk", { status: "in_progress" })), stations(station("kitchen-10", "sona/desk"))]);
  assert.equal(await held.run("kitchen-21"), 1);
  assert.match(held.err.at(-1) ?? "", /kitchen turn: kitchen-21 is held by a turn at sona\/desk/);

  const closed = kitchen(t, [shown(phase("kitchen-21", "kitchen-20", "sona/desk", { status: "closed" })), stations(station("kitchen-10", "sona/desk"))]);
  assert.equal(await closed.run("kitchen-21"), 1);
  assert.match(closed.err.at(-1) ?? "", /kitchen turn: kitchen-21 is closed/);

  for (const k of [held, closed]) {
    assert.equal(k.writes().length, 0);
    assert.equal(k.claude().length, 0);
  }
});

test("a phase that is open but not ready (blocked by a pass or a dependency) is refused", async (t) => {
  const k = kitchen(t, [shown(GRILL), stations(station("kitchen-10", "sona/desk")), ready("sona/desk")]);

  assert.equal(await k.run("kitchen-21"), 1);

  assert.match(k.err.at(-1) ?? "", /kitchen turn: kitchen-21 is not ready: blocked by an open pass or dependency/);
  assert.equal(k.writes().length, 0);
});

test("an order another turn took first (the race, on any host) is refused at the take with no claim and no session", async (t) => {
  const k = kitchen(t, [
    ...ONE_TURN.slice(0, 3),
    claimed("kitchen-20", { stdout: "", stderr: "Error updating kitchen-20: issue already claimed by raffy/mac\n", exitCode: 1 }),
  ]);

  assert.equal(await k.run("kitchen-21"), 1);

  assert.match(k.err.at(-1) ?? "", /kitchen turn: order kitchen-20 is held by raffy\/mac: its turn must end first/);
  assert.deepEqual(k.writes(), [[...DESK, "update", "kitchen-20", "--claim", "--json"]]);
  assert.equal(k.claude().length, 0);
});

test("a phase another turn claimed between the read and the claim is refused and the take is released", async (t) => {
  const k = kitchen(t, [
    ...ONE_TURN.slice(0, 4),
    claimed("kitchen-21", { stdout: "", stderr: "Error updating kitchen-21: issue already claimed by sona/desk\n", exitCode: 1 }),
    released("kitchen-20"),
  ]);

  assert.equal(await k.run("kitchen-21"), 1);

  assert.match(k.err.at(-1) ?? "", /kitchen turn: kitchen-21 is held by another turn at sona\/desk/);
  assert.deepEqual(k.writes().map((argv) => argv.slice(2)), [
    ["update", "kitchen-20", "--claim", "--json"],
    ["update", "kitchen-21", "--claim", "--json"],
    ["update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ]);
  assert.equal(k.claude().length, 0);
});

test("a bead that is not a laid phase, or a phase bd does not know, is refused with the reason", async (t) => {
  const notLaid = kitchen(t, [shown({ id: "kitchen-10", title: "sona/desk", status: "open", issue_type: "station", labels: ["owner:sona"] })]);
  assert.equal(await notLaid.run("kitchen-10"), 1);
  assert.match(notLaid.err.at(-1) ?? "", /kitchen turn: kitchen-10 carries no phase: label/);

  const unknown = kitchen(t, [{ command: "bd", args: [...OWNER, "show", "kitchen-99"], stderr: "Error: issue not found: kitchen-99\n", exitCode: 1 }]);
  assert.equal(await unknown.run("kitchen-99"), 1);
  assert.match(unknown.err.at(-1) ?? "", /kitchen turn: bd --actor sona show kitchen-99 --json failed \(exit 1\): Error: issue not found: kitchen-99/);
});

test("the arguments, the host config and the actor are checked before any call: one phase id, a host that ran kitchen init, and a person at the terminal", async (t) => {
  const k = kitchen(t, []);
  assert.equal(await k.run(), 1);
  assert.match(k.err.at(-1) ?? "", /kitchen turn: a phase id is required\n\nUsage: kitchen turn <phase>/);
  assert.equal(await k.run("kitchen-21", "kitchen-22"), 1);
  assert.match(k.err.at(-1) ?? "", /kitchen turn: one phase at a time, got kitchen-21 kitchen-22/);
  assert.equal(await k.run("--help"), 0);
  assert.match(k.out.at(-1) ?? "", /^Usage: kitchen turn <phase>/);
  fs.rmSync(k.configFile);
  assert.equal(await k.run("kitchen-21"), 1);
  assert.match(k.err.at(-1) ?? "", /run kitchen init first/);
  assert.equal(k.runner.calls.length, 0);

  const session = kitchen(t, [], { sessionEnv: { BEADS_ACTOR: "sona/desk" } });
  assert.equal(await session.run("kitchen-21"), 1);
  assert.match(session.err.at(-1) ?? "", /kitchen turn: a turn on an attended station starts on a person's word, not from a session running as sona\/desk/);
  assert.equal(session.runner.calls.length, 0);
});
