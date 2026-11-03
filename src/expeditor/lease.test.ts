// Leases and failures, exercised through `kitchen up --foreground --once` on the fake clock: the
// heartbeats while the child lives, the reclaim of a phase a dead child left open with its assignee
// restored from the `station:` label, the failure count on a non-zero exit, a budget overrun or the
// wall-clock kill, the `turn failed` pass at the second failure, and the stale leases `bd reclaim`
// finds on tick. The per-order take is released on every path.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

const EXPEDITOR = ["--actor", "sona/expeditor"];
const OVEN = ["--actor", "sona/oven"];

/** Beneath every table: no gate open and no closed pass to apply (answers.test.ts scripts those). */
const QUIET: ScriptedAnswer[] = [
  { command: "bd", args: [...EXPEDITOR, "gate", "check", "--json"], stdout: "No open gates found.\n" },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "gate", "--status", "closed"], stdout: "[]" },
];

function kitchen(t: { after(fn: () => void): void }, table: ScriptedAnswer[]) {
  table.push(...QUIET);
  const host = initialisedHost(t, table);
  const run = () => main(["up", "--foreground", "--once"], host.deps);
  /** Every bd call's argv after `bd`, actor included. */
  const bd = () => host.runner.calls.filter((c) => c.argv[0] === "bd").map((c) => c.argv.slice(1));
  const claude = () => host.runner.calls.filter((c) => c.argv[0] === "claude");
  const logFile = path.join(host.home, ".local", "state", "kitchen", "expeditor.jsonl");
  const log = (): Record<string, unknown>[] =>
    fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...host, table, run, bd, claude, log };
}

const PHASE_TEXT = (slug: string) =>
  `---\nphase: ${slug}\nskill: umka:${slug}\nfrom: []\nto: []\nartifact: a PR\nmodel: claude-opus-5\nentry: [ticket]\nbudget:\n  usd: 5\n  effort: high\n---\n# ${slug}\n`;

const station = (id: string, name: string, timeout = "45m") => ({
  id, title: `sona/${name}`, status: "open", issue_type: "station",
  labels: ["owner:sona", "host:sona-laptop", "cap:2"],
  notes: `offers: nomadec/kitchen checked out\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models: ["claude-opus-5"], auth: "subscription", plugins: [], skills: [],
    repositories: [{ slug: "nomadec/kitchen", path: "/home/sona/src/kitchen" }],
    worktrees: "per-order", cap: 2, budget: { usd: 5, effort: "high" }, timeout, secrets: [],
  })}\n\`\`\``,
});

const phase = (id: string, order: string, slug: string, stationName: string, options: { labels?: string[]; status?: string; assignee?: string | null } = {}) => ({
  id, title: `${slug}: Stale cookie`, status: options.status ?? "open", issue_type: "task", parent: order,
  ...(options.assignee === null ? {} : { assignee: options.assignee ?? `sona/${stationName}` }),
  labels: [`phase:${slug}`, `station:sona/${stationName}`, ...(options.labels ?? [])],
  notes: "model: claude-opus-5",
  description: PHASE_TEXT(slug),
});

const stations = (...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--type", "station", "--label", "owner:sona", "--label", "host:sona-laptop"], stdout: JSON.stringify(rows),
});
const reclaimed = (...rows: { id: string; previous_owner: string }[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "reclaim", "--json"], stdout: JSON.stringify({ count: rows.length, reclaimed: rows.length ? rows : null, schema_version: 1, scoped: false }),
});
const ready = (stationName: string, ...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "ready", "--assignee", `sona/${stationName}`], stdout: JSON.stringify(rows),
});
const held = (): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--status", "in_progress"], stdout: "[]" });
const running = (stationName: string): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--assignee", `sona/${stationName}`, "--status", "in_progress"], stdout: "[]",
});
const claimed = (stationName: string, id: string): ScriptedAnswer => ({
  command: "bd", args: ["--actor", `sona/${stationName}`, "update", id, "--claim"], stdout: JSON.stringify([{ id, status: "in_progress", assignee: `sona/${stationName}` }]),
});
const heartbeat = (stationName: string, id: string, answer: Partial<ScriptedAnswer> = {}): ScriptedAnswer => ({
  command: "bd", args: ["--actor", `sona/${stationName}`, "heartbeat", id], stdout: JSON.stringify({ id, owner: `sona/${stationName}`, status: "heartbeat" }), ...answer,
});
const shown = (bead: { id: string; [field: string]: unknown }): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "show", bead.id], stdout: JSON.stringify([bead]) });
const updated = (actor: string[], id: string): ScriptedAnswer => ({ command: "bd", args: [...actor, "update", id], stdout: "[]" });
const released = (stationName: string, id: string): ScriptedAnswer => ({
  command: "bd", args: ["--actor", `sona/${stationName}`, "update", id, "--status", "open", "--assignee", ""], stdout: "[]",
});
const commented = (id: string): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "comments", "add", id], stdout: "{}" });
const turn = (stdout: string, answer: Partial<ScriptedAnswer> = {}): ScriptedAnswer => ({ command: "claude", args: [], stdout, ...answer });
const passLaid = (id: string, title: string): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "gate", "create"], stdout: JSON.stringify({ id, title, status: "open", issue_type: "gate", await_type: "human" }),
});

/** One tick with one ready phase on the oven, up to the claim; what follows the child is the test's. */
const oneTurn = (phaseRow: object, stationTimeout = "45m"): ScriptedAnswer[] => [
  stations(station("kitchen-10", "oven", stationTimeout)),
  reclaimed(),
  ready("oven", phaseRow),
  held(),
  running("oven"),
  claimed("oven", "kitchen-20"),
  claimed("oven", "kitchen-21"),
];

const MINUTE = 60_000;
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * MINUTE).toISOString();

test("while the child runs, the phase and its order are heartbeated as the station once a minute; the heartbeats stop when it exits", async (t) => {
  const k = kitchen(t, [
    ...oneTurn(phase("kitchen-21", "kitchen-20", "reproduce", "oven")),
    heartbeat("oven", "kitchen-21"),
    heartbeat("oven", "kitchen-20"),
    turn("kitchen-21 closed\n", { lasts: 2.5 * MINUTE }),
    commented("kitchen-21"),
    shown(phase("kitchen-21", "kitchen-20", "reproduce", "oven", { status: "closed" })),
    released("oven", "kitchen-20"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  const heartbeats = k.bd().filter((argv) => argv[2] === "heartbeat");
  assert.deepEqual(heartbeats, [
    [...OVEN, "heartbeat", "kitchen-21", "--json"],
    [...OVEN, "heartbeat", "kitchen-20", "--json"],
    [...OVEN, "heartbeat", "kitchen-21", "--json"],
    [...OVEN, "heartbeat", "kitchen-20", "--json"],
  ], "two rounds in two and a half minutes, the phase before its order");
  const beats = k.log().filter((line) => line.step === "heartbeat");
  assert.deepEqual(beats.map((line) => [line.at, line.phase, line.order, line.station]), [
    [at(1), "kitchen-21", "kitchen-20", "sona/oven"],
    [at(2), "kitchen-21", "kitchen-20", "sona/oven"],
  ]);
  const end = k.log().find((line) => line.step === "turn");
  assert.deepEqual({ at: end?.at, exit: end?.exit, outcome: end?.outcome }, { at: at(2.5), exit: 0, outcome: "closed" });
  assert.deepEqual(k.bd().at(-1), [...OVEN, "update", "kitchen-20", "--status", "open", "--assignee", "", "--json"], "the take is released last");
});

test("a child exiting non-zero with its phase open has the phase released by the station and restored by the expeditor to its station: label with failed:1, then the order released", async (t) => {
  const k = kitchen(t, [
    ...oneTurn(phase("kitchen-21", "kitchen-20", "reproduce", "oven")),
    turn("Working...\n", { exitCode: 3 }),
    commented("kitchen-21"),
    shown(phase("kitchen-21", "kitchen-20", "reproduce", "oven", { status: "in_progress" })),
    released("oven", "kitchen-21"),
    updated(EXPEDITOR, "kitchen-21"),
    released("oven", "kitchen-20"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().filter((argv) => argv[2] === "update" && !argv.includes("--claim")), [
    [...OVEN, "update", "kitchen-21", "--status", "open", "--assignee", "", "--json"],
    [...EXPEDITOR, "update", "kitchen-21", "--add-label", "failed:1", "--assignee", "sona/oven", "--json"],
    [...OVEN, "update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ]);
  assert.ok(!k.bd().some((argv) => argv[2] === "gate" && argv[3] === "create"), "one failure lays no pass");
  const end = k.log().find((line) => line.step === "turn");
  assert.deepEqual({ exit: end?.exit, outcome: end?.outcome, failure: end?.failure, failures: end?.failures }, { exit: 3, outcome: "failed", failure: "exit 3", failures: 1 });
});

test("a second failure counts failed:2 in place of failed:1, lays the turn failed pass for the owner under the order, and the phase is not started again on a later tick", async (t) => {
  const k = kitchen(t, [
    ...oneTurn(phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:1"] })),
    turn("", { exitCode: 1 }),
    commented("kitchen-21"),
    shown(phase("kitchen-21", "kitchen-20", "reproduce", "oven", { status: "in_progress", labels: ["failed:1"] })),
    released("oven", "kitchen-21"),
    updated(EXPEDITOR, "kitchen-21"),
    passLaid("kitchen-22", "turn failed: reproduce"),
    updated(EXPEDITOR, "kitchen-22"),
    released("oven", "kitchen-20"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().filter((argv) => (argv[2] === "update" && !argv.includes("--claim")) || (argv[2] === "gate" && argv[3] === "create")), [
    [...OVEN, "update", "kitchen-21", "--status", "open", "--assignee", "", "--json"],
    [...EXPEDITOR, "update", "kitchen-21", "--add-label", "failed:2", "--remove-label", "failed:1", "--assignee", "sona/oven", "--json"],
    [...EXPEDITOR, "gate", "create", "--type", "human", "--blocks", "kitchen-21", "--title", "turn failed: reproduce", "--reason", "kitchen-21 (reproduce: Stale cookie) failed 2 times on sona/oven; the last turn exit 1: exit 1", "--json"],
    [...EXPEDITOR, "update", "kitchen-22", "--parent", "kitchen-20", "--assignee", "sona", "--json"],
    [...OVEN, "update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ]);
  const end = k.log().find((line) => line.step === "turn");
  assert.deepEqual({ outcome: end?.outcome, failures: end?.failures, pass: end?.pass }, { outcome: "failed", failures: 2, pass: "kitchen-22" });

  // The next tick: bd lists the phase, now failed:2, as ready regardless (the pass's dependency not yet in bd's view).
  k.table.unshift(ready("oven", phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:2"] })));
  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 1, "no third claude call");
  assert.deepEqual(k.log().filter((line) => line.tick === 1 && line.step === "ready" && line.dropped).map((line) => [line.phase, line.dropped]), [["kitchen-21", "failed:2: waits for the turn failed pass"]]);
});

test("a child that outlives the station's wall-clock timeout is killed, the kill is logged, and it counts as a failure", async (t) => {
  const k = kitchen(t, [
    ...oneTurn(phase("kitchen-21", "kitchen-20", "reproduce", "oven"), "2m"),
    heartbeat("oven", "kitchen-21"),
    heartbeat("oven", "kitchen-20"),
    turn("never\n", { lasts: 60 * MINUTE }),
    commented("kitchen-21"),
    shown(phase("kitchen-21", "kitchen-20", "reproduce", "oven", { status: "in_progress" })),
    released("oven", "kitchen-21"),
    updated(EXPEDITOR, "kitchen-21"),
    released("oven", "kitchen-20"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  const [call] = k.claude();
  assert.ok(call?.signal?.aborted, "the child was killed through its signal");
  assert.equal(k.bd().filter((argv) => argv[2] === "heartbeat").length, 2, "one round of heartbeats in the two minutes");
  assert.deepEqual(k.log().filter((line) => line.step === "turn").map((line) => [line.at, line.killed ?? line.outcome]), [
    [at(2), "killed at the wall-clock timeout of 2m"],
    [at(2), "failed"],
  ]);
  const end = k.log().findLast((line) => line.step === "turn");
  assert.deepEqual({ exit: end?.exit, result: end?.result, failure: end?.failure, failures: end?.failures }, { exit: 128, result: "exit 128", failure: "killed at the wall-clock timeout of 2m", failures: 1 });
  assert.deepEqual(k.bd().slice(-3), [
    [...OVEN, "update", "kitchen-21", "--status", "open", "--assignee", "", "--json"],
    [...EXPEDITOR, "update", "kitchen-21", "--add-label", "failed:1", "--assignee", "sona/oven", "--json"],
    [...OVEN, "update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ]);
});

test("a child that exits clean without closing its phase has the phase reclaimed: open again, assigned to the station its label names, no failure counted; the order is released", async (t) => {
  const k = kitchen(t, [
    ...oneTurn(phase("kitchen-21", "kitchen-20", "reproduce", "oven")),
    turn("stopped early\n"),
    commented("kitchen-21"),
    shown(phase("kitchen-21", "kitchen-20", "reproduce", "oven", { status: "in_progress" })),
    released("oven", "kitchen-21"),
    updated(EXPEDITOR, "kitchen-21"),
    released("oven", "kitchen-20"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().slice(-4), [
    [...EXPEDITOR, "show", "kitchen-21", "--json"],
    [...OVEN, "update", "kitchen-21", "--status", "open", "--assignee", "", "--json"],
    [...EXPEDITOR, "update", "kitchen-21", "--assignee", "sona/oven", "--json"],
    [...OVEN, "update", "kitchen-20", "--status", "open", "--assignee", "", "--json"],
  ]);
  const end = k.log().find((line) => line.step === "turn");
  assert.deepEqual({ exit: end?.exit, outcome: end?.outcome, failures: end?.failures }, { exit: 0, outcome: "reclaimed", failures: undefined });
});

test("a budget overrun the harness reports counts as a failure even on a clean exit", async (t) => {
  const k = kitchen(t, [
    ...oneTurn(phase("kitchen-21", "kitchen-20", "reproduce", "oven")),
    turn("Working...\n", { stderr: "Budget limit reached ($5.02 of $5); stopping background agents.\n" }),
    commented("kitchen-21"),
    shown(phase("kitchen-21", "kitchen-20", "reproduce", "oven", { status: "in_progress" })),
    released("oven", "kitchen-21"),
    updated(EXPEDITOR, "kitchen-21"),
    released("oven", "kitchen-20"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().at(-2), [...EXPEDITOR, "update", "kitchen-21", "--add-label", "failed:1", "--assignee", "sona/oven", "--json"]);
  const end = k.log().find((line) => line.step === "turn");
  assert.deepEqual({ exit: end?.exit, outcome: end?.outcome, failure: end?.failure }, { exit: 0, outcome: "failed", failure: "budget overrun reported by the harness" });
});

test("a stale lease found on tick is reclaimed and a phase's assignee restored from its station: label; a reclaimed order, which has none, stays released", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    reclaimed({ id: "kitchen-31", previous_owner: "sona/oven" }, { id: "kitchen-30", previous_owner: "sona/oven" }),
    shown(phase("kitchen-31", "kitchen-30", "review", "oven", { assignee: null })),
    shown({ id: "kitchen-30", title: "Stale cookie", status: "open", issue_type: "epic", labels: ["loop"] }),
    updated(EXPEDITOR, "kitchen-31"),
    ready("oven"),
    held(),
    running("oven"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  // After the stations, the gate check and the closed-pass list come the reclaim and the restores.
  assert.deepEqual(k.bd().slice(3, 7), [
    [...EXPEDITOR, "reclaim", "--json"],
    [...EXPEDITOR, "show", "kitchen-31", "--json"],
    [...EXPEDITOR, "update", "kitchen-31", "--assignee", "sona/oven", "--json"],
    [...EXPEDITOR, "show", "kitchen-30", "--json"],
  ]);
  const line = k.log().find((entry) => entry.step === "reclaim");
  assert.deepEqual({ reclaimed: line?.reclaimed, restored: line?.restored }, { reclaimed: ["kitchen-31", "kitchen-30"], restored: { "kitchen-31": "sona/oven" } });
  assert.equal(k.claude().length, 0);
});
