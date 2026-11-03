// The expeditor tick, exercised through `kitchen up --foreground --once`: scripted bd ready, station
// beads and config in; the order take, the phase claim and the claude invocation out, the attended
// phases marked waiting, the per-order and per-station limits, the result line commented on the phase
// bead and a log line per step under the state directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

const EXPEDITOR = ["--actor", "sona/expeditor"];
const PROMPT = (phase: string) => `Invoke the Skill tool with skill "kitchen:turn" and args "${phase}"`;

/** Beneath every table: no gate open, no closed pass to apply, no stale lease to reclaim, and a phase read back after its turn is closed. The answers and lease tests script the rest. */
const SETTLED: ScriptedAnswer[] = [
  { command: "bd", args: [...EXPEDITOR, "gate", "check", "--json"], stdout: "No open gates found.\n" },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "gate"], stdout: "[]" },
  { command: "bd", args: [...EXPEDITOR, "reclaim", "--json"], stdout: '{"count":0,"reclaimed":null,"schema_version":1,"scoped":false}' },
  { command: "bd", args: [...EXPEDITOR, "show"], stdout: '[{"id":"kitchen-21","status":"closed","issue_type":"task"}]' },
  // No source is registered on this host in these tests; the poll has its own, poll.test.ts.
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "source"], stdout: "[]" },
];

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[]) {
  const host = initialisedHost(t, [...table, ...SETTLED]);
  const run = (...argv: string[]) => main(["up", "--foreground", "--once", ...argv], host.deps);
  /** Every bd call's argv after `bd`, actor included. */
  const bd = () => host.runner.calls.filter((c) => c.argv[0] === "bd").map((c) => c.argv.slice(1));
  const claude = () => host.runner.calls.filter((c) => c.argv[0] === "claude");
  const logFile = path.join(host.home, ".local", "state", "kitchen", "expeditor.jsonl");
  const log = (): Record<string, unknown>[] =>
    fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...host, run, bd, claude, logFile, log };
}

const PHASE_TEXT = (slug: string, usd = 5, effort = "high") =>
  `---\nphase: ${slug}\nskill: umka:${slug}\nfrom: []\nto: []\nartifact: a PR\nmodel: claude-opus-5\nentry: [ticket]\nbudget:\n  usd: ${usd}\n  effort: ${effort}\n---\n# ${slug}\n`;

const station = (id: string, name: string, cap: number, options: { attended?: boolean; plugins?: string[] } = {}) => ({
  id, title: `sona/${name}`, status: "open", issue_type: "station",
  labels: ["owner:sona", "host:sona-laptop", `cap:${cap}`, ...(options.attended ? ["attended"] : [])],
  notes: `offers: nomadec/kitchen checked out\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models: ["claude-opus-5"], auth: "subscription", plugins: options.plugins ?? [], skills: [],
    repositories: [{ slug: "nomadec/kitchen", path: "/home/sona/src/kitchen" }, { slug: "sona-is/sona", path: "/home/sona/src/sona" }],
    worktrees: "per-order", cap, budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [],
  })}\n\`\`\``,
});

const phase = (id: string, order: string, slug: string, stationName: string, options: { labels?: string[]; usd?: number; notes?: string } = {}) => ({
  id, title: `${slug}: Stale cookie`, status: "open", issue_type: "task", parent: order, assignee: `sona/${stationName}`,
  labels: [`phase:${slug}`, `station:sona/${stationName}`, ...(options.labels ?? [])],
  notes: options.notes ?? "model: claude-opus-5",
  description: PHASE_TEXT(slug, options.usd),
});

const order = (id: string, assignee?: string) => ({
  id, title: "Stale cookie", status: assignee ? "in_progress" : "open", issue_type: "epic", labels: ["loop"],
  notes: "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: bug", ...(assignee ? { assignee } : {}),
});

const stations = (...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--type", "station", "--label", "owner:sona", "--label", "host:sona-laptop"], stdout: JSON.stringify(rows),
});
const ready = (stationName: string, ...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "ready", "--assignee", `sona/${stationName}`], stdout: JSON.stringify(rows),
});
const held = (...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--status", "in_progress"], stdout: JSON.stringify(rows),
});
const running = (stationName: string, ...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--assignee", `sona/${stationName}`, "--status", "in_progress"], stdout: JSON.stringify(rows),
});
const claimed = (stationName: string, id: string, answer: Partial<ScriptedAnswer> = {}): ScriptedAnswer => ({
  command: "bd", args: ["--actor", `sona/${stationName}`, "update", id, "--claim"], stdout: JSON.stringify([{ id, status: "in_progress", assignee: `sona/${stationName}` }]), ...answer,
});
const released = (stationName: string, id: string): ScriptedAnswer => ({
  command: "bd", args: ["--actor", `sona/${stationName}`, "update", id, "--status", "open", "--assignee", ""], stdout: "[]",
});
const commented = (id: string): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "comments", "add", id], stdout: "{}" });
const turn = (stdout: string, exitCode = 0): ScriptedAnswer => ({ command: "claude", args: [], stdout, exitCode });

const ONE_READY = [
  stations(station("kitchen-10", "oven", 2, { plugins: ["/home/sona/.claude/plugins/umka"] })),
  ready("oven", phase("kitchen-21", "kitchen-20", "reproduce", "oven")),
  held(),
  running("oven"),
  claimed("oven", "kitchen-20"),
  claimed("oven", "kitchen-21"),
  turn("Working...\nkitchen-21 closed: https://github.com/nomadec/kitchen/pull/9\n"),
  commented("kitchen-21"),
  released("oven", "kitchen-20"),
];

test("one tick issues the order take, the phase claim and a claude invocation carrying model, actor, plugin directories, print flag, effort and dollar cap, in that order", async (t) => {
  const k = kitchen(t, ONE_READY);

  const code = await k.run();

  assert.equal(code, 0, k.err.join(""));
  const writes = k.bd().filter((argv) => argv[2] === "update" || argv[2] === "comments");
  assert.deepEqual(writes.slice(0, 2), [
    ["--actor", "sona/oven", "update", "kitchen-20", "--claim", "--json"],
    ["--actor", "sona/oven", "update", "kitchen-21", "--claim", "--json"],
  ]);
  const [call] = k.claude();
  assert.ok(call, "claude was invoked");
  assert.deepEqual(call.argv, [
    "claude",
    "--model", "claude-opus-5",
    "--plugin-dir", "/opt/kitchen/plugin",
    "--plugin-dir", "/home/sona/.claude/plugins/umka",
    "--print",
    "--effort", "high",
    "--max-budget-usd", "5",
    "--dangerously-skip-permissions",
    PROMPT("kitchen-21"),
  ]);
  assert.equal(call.cwd, "/home/sona/src/kitchen", "the station's first checkout: the taken order names no repository, so there is no worktree");
  assert.deepEqual(call.env, {
    BEADS_ACTOR: "sona/oven",
    BEADS_DIR: path.join(k.configDir, "space", ".beads"),
    BEADS_CREDENTIALS_FILE: "/home/sona/.config/beads/credentials",
  });
  const order = k.runner.calls.map((c) => c.argv).flatMap((argv) => (argv[0] === "claude" ? ["claude"] : argv[3] === "update" ? [argv.slice(3, 6).join(" ")] : []));
  assert.deepEqual(order.slice(0, 3), ["update kitchen-20 --claim", "update kitchen-21 --claim", "claude"]);
  for (const call of k.runner.calls.filter((c) => c.argv[0] === "bd")) assert.deepEqual({ cwd: call.cwd, env: call.env }, k.connection);
});

test("a phase whose order is held by another turn, on this host or another, is skipped: no take, no claim, no claude call; an order in progress but taken by no station is not held", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven", 2)),
    ready("oven",
      phase("kitchen-21", "kitchen-20", "reproduce", "oven"),
      phase("kitchen-31", "kitchen-30", "review", "oven"),
      phase("kitchen-51", "kitchen-50", "reproduce", "oven"),
    ),
    held(order("kitchen-20", "sona/desk"), order("kitchen-30", "raffy/mac"), { ...order("kitchen-50"), status: "in_progress" }),
    running("oven"),
    claimed("oven", "kitchen-50"),
    claimed("oven", "kitchen-51"),
    turn("kitchen-51 closed\n"),
    commented("kitchen-51"),
    released("oven", "kitchen-50"),
  ]);

  const code = await k.run();

  assert.equal(code, 0, k.err.join(""));
  assert.equal(k.claude().length, 1);
  assert.deepEqual(k.bd().filter((argv) => argv.includes("--claim")).map((argv) => argv[3]), ["kitchen-50", "kitchen-51"], "the one take and claim are for the order no station holds");
  const dropped = k.log().filter((line) => line.step === "orders" && line.dropped);
  assert.deepEqual(dropped.map((line) => [line.phase, line.dropped]), [["kitchen-21", "held by sona/desk"], ["kitchen-31", "held by raffy/mac"]]);
});

test("a take that bd refuses because another expeditor took the order first (the race) drops the phase without a claim or a claude call", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven", 2)),
    ready("oven", phase("kitchen-21", "kitchen-20", "reproduce", "oven")),
    held(),
    running("oven"),
    claimed("oven", "kitchen-20", { stdout: "", stderr: "Error updating kitchen-20: issue already claimed by sona/desk\n", exitCode: 1 }),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 0);
  assert.deepEqual(k.bd().filter((argv) => argv.includes("--claim")), [["--actor", "sona/oven", "update", "kitchen-20", "--claim", "--json"]]);
  assert.deepEqual(k.log().filter((line) => line.step === "dispatch" && line.dropped).map((line) => line.dropped), ["order held by sona/desk"]);
});

test("two ready phases of one order start one turn: the second is dropped as held by the turn just started", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven", 2)),
    ready("oven", phase("kitchen-21", "kitchen-20", "reproduce", "oven"), phase("kitchen-22", "kitchen-20", "implement", "oven")),
    held(),
    running("oven"),
    claimed("oven", "kitchen-20"),
    claimed("oven", "kitchen-21"),
    turn("kitchen-21 closed\n"),
    commented("kitchen-21"),
    released("oven", "kitchen-20"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 1);
  assert.deepEqual(k.log().filter((line) => line.step === "dispatch" && line.dropped).map((line) => [line.phase, line.dropped]), [["kitchen-22", "held by sona/oven"]]);
});

test("a station at its cap is skipped: the turns in progress at it fill its slots, and the order it holds is not a turn", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven", 1)),
    ready("oven", phase("kitchen-21", "kitchen-20", "reproduce", "oven")),
    held(order("kitchen-40", "sona/oven")),
    running("oven", { id: "kitchen-41", status: "in_progress", issue_type: "task", labels: ["phase:review"] }, order("kitchen-40", "sona/oven")),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 0);
  assert.ok(!k.bd().some((argv) => argv.includes("--claim")));
  assert.deepEqual(k.log().filter((line) => line.step === "caps" && line.dropped).map((line) => [line.phase, line.dropped]), [["kitchen-21", "at its cap of 1"]]);
  assert.deepEqual(k.log().find((line) => line.step === "caps" && line.running)?.running, { "sona/oven": 1 });
});

test("a station with one free slot and two ready phases of two orders starts one turn and drops the other at the cap", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven", 1)),
    ready("oven", phase("kitchen-21", "kitchen-20", "reproduce", "oven"), phase("kitchen-31", "kitchen-30", "reproduce", "oven")),
    held(),
    running("oven"),
    claimed("oven", "kitchen-20"),
    claimed("oven", "kitchen-21"),
    turn("kitchen-21 closed\n"),
    commented("kitchen-21"),
    released("oven", "kitchen-20"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 1);
  assert.deepEqual(k.log().filter((line) => line.step === "dispatch" && line.dropped).map((line) => [line.phase, line.dropped]), [["kitchen-31", "at its cap of 1"]]);
});

test("a phase on an attended station is recorded as waiting, with the kitchen turn command, and no claude call is made; one already waiting is not labelled again", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven", 2), station("kitchen-11", "desk", 1, { attended: true })),
    ready("oven"),
    ready("desk", phase("kitchen-21", "kitchen-20", "grill", "desk"), phase("kitchen-31", "kitchen-30", "grill", "desk", { labels: ["waiting"] })),
    held(),
    running("oven"),
    running("desk"),
    { command: "bd", args: [...EXPEDITOR, "update", "kitchen-21", "--add-label", "waiting"], stdout: "[]" },
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 0);
  assert.ok(!k.bd().some((argv) => argv.includes("--claim")));
  assert.deepEqual(k.bd().filter((argv) => argv[2] === "update"), [[...EXPEDITOR, "update", "kitchen-21", "--add-label", "waiting", "--json"]]);
  const waiting = k.log().filter((line) => line.step === "attended" && line.phase);
  assert.deepEqual(waiting.map((line) => [line.phase, line.station, line.waiting]), [
    ["kitchen-21", "sona/desk", "kitchen turn kitchen-21"],
    ["kitchen-31", "sona/desk", "kitchen turn kitchen-31"],
  ]);
  assert.match(k.out.join(""), /started 0, waiting 2/);
});

test("the turn's result line, the last line of its output, is appended as a comment on the phase bead and the order is released; the log holds a line per step in tick order and the turn's end", async (t) => {
  const k = kitchen(t, ONE_READY);

  assert.equal(await k.run(), 0, k.err.join(""));

  const writes = k.bd().filter((argv) => argv[2] === "update" || argv[2] === "comments");
  assert.deepEqual(writes.slice(2), [
    [...EXPEDITOR, "comments", "add", "kitchen-21", "kitchen-21 closed: https://github.com/nomadec/kitchen/pull/9", "--json"],
    ["--actor", "sona/oven", "update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ]);
  const steps = k.log().map((line) => line.step);
  const firstOf = (step: string) => steps.indexOf(step);
  const expected = ["config", "stations", "gates", "passes", "sources", "leases", "reclaim", "worktrees", "ready", "orders", "caps", "attended", "dispatch", "turn"];
  assert.deepEqual([...new Set(steps)], expected, "every step logs, in tick order");
  assert.ok(expected.every((step, i) => i === 0 || firstOf(step) > firstOf(expected[i - 1] ?? "")));
  for (const line of k.log()) {
    assert.equal(line.tick, 1);
    assert.match(String(line.at), /^2026-01-01T00:00:00\.000Z$/);
  }
  assert.deepEqual(k.log().find((line) => line.step === "sources")?.sources, [], "the poll ran and found no source on this host");
  assert.equal(k.log().find((line) => line.step === "gates")?.gates, "none open");
  assert.deepEqual(k.log().find((line) => line.step === "passes")?.applied, []);
  assert.deepEqual(k.log().find((line) => line.step === "leases")?.alive, [], "no turn lives yet at the first tick's leases step");
  assert.deepEqual(k.log().find((line) => line.step === "reclaim")?.reclaimed, []);
  const turn = k.log().find((line) => line.step === "turn");
  assert.deepEqual({ phase: turn?.phase, order: turn?.order, exit: turn?.exit, result: turn?.result }, {
    phase: "kitchen-21", order: "kitchen-20", exit: 0, result: "kitchen-21 closed: https://github.com/nomadec/kitchen/pull/9",
  });
});

test("a session that prints nothing has its exit code commented as the result line", async (t) => {
  const k = kitchen(t, [...ONE_READY.slice(0, 6), turn("", 3), commented("kitchen-21"), released("oven", "kitchen-20")]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().find((argv) => argv[2] === "comments")?.slice(2), ["comments", "add", "kitchen-21", "exit 3", "--json"]);
});

test("a host without kitchen init is refused before any call", async (t) => {
  const k = kitchen(t, []);
  fs.rmSync(k.configFile);
  assert.notEqual(await k.run(), 0);
  assert.match(k.err.at(-1) ?? "", /run kitchen init first/);
  assert.equal(k.runner.calls.length, 0);
});
