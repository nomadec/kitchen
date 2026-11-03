// The two tick steps between the stations and the sources, exercised through `kitchen up --foreground
// --once`: `bd gate check` for the typed gates each tick, and the human's word applied on a closed
// Kitchen-laid pass (`retry`, `retry <station title>`, `stop`, any other word), the pass labelled
// `applied` so the word is applied once however many ticks or restarts follow.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

const EXPEDITOR = ["--actor", "sona/expeditor"];

/** Beneath every table: no stale lease to reclaim, and a phase read back after its turn is closed. */
const SETTLED: ScriptedAnswer[] = [
  { command: "bd", args: [...EXPEDITOR, "reclaim", "--json"], stdout: '{"count":0,"reclaimed":null,"schema_version":1,"scoped":false}' },
  { command: "bd", args: [...EXPEDITOR, "show"], stdout: '[{"id":"kitchen-21","status":"closed","issue_type":"task"}]' },
];

function kitchen(t: { after(fn: () => void): void }, table: ScriptedAnswer[]) {
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

const station = (id: string, name: string, options: { attended?: boolean } = {}) => ({
  id, title: `sona/${name}`, status: "open", issue_type: "station",
  labels: ["owner:sona", "host:sona-laptop", "cap:2", ...(options.attended ? ["attended"] : [])],
  notes: `offers: nomadec/kitchen checked out\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models: ["claude-opus-5"], auth: "subscription", plugins: [], skills: [],
    repositories: [{ slug: "nomadec/kitchen", path: "/home/sona/src/kitchen" }],
    worktrees: "per-order", cap: 2, budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [],
  })}\n\`\`\``,
});

const phase = (id: string, order: string, slug: string, stationName: string, options: { labels?: string[]; status?: string } = {}) => ({
  id, title: `${slug}: Stale cookie`, status: options.status ?? "open", issue_type: "task", parent: order, assignee: `sona/${stationName}`,
  labels: [`phase:${slug}`, `station:sona/${stationName}`, ...(options.labels ?? [])],
  notes: "model: claude-opus-5",
  description: PHASE_TEXT(slug),
});

/** A closed pass as `bd list` prints it: the human's word is its close reason. */
const pass = (id: string, title: string, word: string, options: { parent?: string | null; labels?: string[]; await_type?: string } = {}) => ({
  id, title, status: "closed", issue_type: "gate", await_type: options.await_type ?? "human", close_reason: word,
  ...(options.parent === null ? {} : { parent: options.parent ?? "kitchen-20" }),
  ...(options.labels ? { labels: options.labels } : {}),
});

const stations = (...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--type", "station", "--label", "owner:sona", "--label", "host:sona-laptop"], stdout: JSON.stringify(rows),
});
const gatesChecked = (stdout: string): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "gate", "check", "--json"], stdout });
const NO_GATES = gatesChecked("No open gates found.\n");
/** The owner's closed gates not yet applied, as the passes step lists them. */
const closedPasses = (...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--type", "gate", "--assignee", "sona", "--status", "closed", "--exclude-label", "applied", "--limit", "0", "--json"], stdout: JSON.stringify(rows),
});
/** The beads behind a gate: what it blocks. */
const behind = (gate: string, ...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "dep", "list", gate, "--direction", "up", "--type", "blocks", "--json"], stdout: JSON.stringify(rows),
});
const children = (order: string, ...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--parent", order, "--limit", "0", "--json"], stdout: JSON.stringify(rows),
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
const updated = (id: string): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "update", id], stdout: "[]" });
const closed = (id: string): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "close", id], stdout: "[]" });
const released = (stationName: string, id: string): ScriptedAnswer => ({
  command: "bd", args: ["--actor", `sona/${stationName}`, "update", id, "--status", "open", "--assignee", ""], stdout: "[]",
});
const commented = (id: string): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "comments", "add", id], stdout: "{}" });
const turn = (stdout: string): ScriptedAnswer => ({ command: "claude", args: [], stdout });

/** The rest of a tick that starts one turn on kitchen-21 of kitchen-20 at the oven. */
const oneTurn = (): ScriptedAnswer[] => [
  held(), running("oven"), claimed("oven", "kitchen-20"), claimed("oven", "kitchen-21"), turn("kitchen-21 closed\n"), commented("kitchen-21"), released("oven", "kitchen-20"),
];

/** What `bd gate check --json` prints when the merged PR a gh:pr gate waits on resolves it: a line per gate, then the counts. */
const ONE_RESOLVED = "✓ kitchen-23: resolved - PR merged\n\nChecked 1 gates: 1 resolved, 0 escalated, 0 errors\n{\n  \"checked\": 1,\n  \"dry_run\": false,\n  \"errors\": 0,\n  \"escalated\": 0,\n  \"resolved\": 1,\n  \"schema_version\": 1\n}\n";

test("each tick runs bd gate check before the passes; a gh:pr gate bd resolves (the scripted merged state) is logged, and the phase behind it is dispatched from bd ready on the next tick without a session spent on the wait", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    gatesChecked(ONE_RESOLVED),
    closedPasses(pass("kitchen-23", "merge of kitchen/kitchen-20", "PR merged", { await_type: "gh:pr" })),
    ready("oven"),
    held(),
    running("oven"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().slice(1, 3), [
    [...EXPEDITOR, "gate", "check", "--json"],
    [...EXPEDITOR, "list", "--type", "gate", "--assignee", "sona", "--status", "closed", "--exclude-label", "applied", "--limit", "0", "--json"],
  ], "the gates are checked right after the stations are read, then the closed passes listed");
  const gates = k.log().find((line) => line.step === "gates");
  assert.deepEqual({ checked: gates?.checked, resolved: gates?.resolved, escalated: gates?.escalated, errors: gates?.errors }, { checked: 1, resolved: ["kitchen-23"], escalated: 0, errors: 0 });
  assert.equal(k.claude().length, 0);
  assert.ok(!k.bd().some((argv) => argv[2] === "update"), "a typed gate carries no word to apply: nothing is written");
  assert.deepEqual(k.log().find((line) => line.step === "passes")?.applied, []);

  // The next tick: bd ready lists the phase the gate blocked, and it starts like any other.
  k.table.unshift(NO_GATES, closedPasses(), ready("oven", phase("kitchen-21", "kitchen-20", "merge", "oven")), ...oneTurn());
  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 1);
  assert.deepEqual(k.log().filter((line) => line.step === "gates").map((line) => line.resolved ?? line.gates), [["kitchen-23"], "none open"]);
});

test("a closed turn failed pass with the word retry reopens the phase with its failed: label removed, as the expeditor, then labels the pass applied; the phase starts from bd ready in the same tick", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    NO_GATES,
    closedPasses(pass("kitchen-22", "turn failed: reproduce", "retry")),
    behind("kitchen-22", phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:2"] })),
    updated("kitchen-21"),
    updated("kitchen-22"),
    ready("oven", phase("kitchen-21", "kitchen-20", "reproduce", "oven")),
    ...oneTurn(),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().slice(2, 6), [
    [...EXPEDITOR, "list", "--type", "gate", "--assignee", "sona", "--status", "closed", "--exclude-label", "applied", "--limit", "0", "--json"],
    [...EXPEDITOR, "dep", "list", "kitchen-22", "--direction", "up", "--type", "blocks", "--json"],
    [...EXPEDITOR, "update", "kitchen-21", "--remove-label", "failed:2", "--status", "open", "--json"],
    [...EXPEDITOR, "update", "kitchen-22", "--add-label", "applied", "--json"],
  ]);
  assert.equal(k.claude().length, 1, "the reopened phase is dispatched");
  const applied = k.log().find((line) => line.step === "passes" && line.pass);
  assert.deepEqual({ pass: applied?.pass, word: applied?.word, applied: applied?.applied, phases: applied?.phases }, { pass: "kitchen-22", word: "retry", applied: "retry", phases: ["kitchen-21"] });
  assert.deepEqual(k.log().find((line) => line.step === "passes" && line.applied instanceof Array)?.applied, ["kitchen-22"]);
});

test("retry <station title> reassigns the phase: the assignee and the station: label move to the named station in the same write", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    NO_GATES,
    closedPasses(pass("kitchen-22", "turn failed: reproduce", "retry sona/desk")),
    behind("kitchen-22", phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:2"] })),
    updated("kitchen-21"),
    updated("kitchen-22"),
    ready("oven"),
    held(),
    running("oven"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().find((argv) => argv[2] === "update" && argv[3] === "kitchen-21"), [
    ...EXPEDITOR, "update", "kitchen-21", "--add-label", "station:sona/desk", "--remove-label", "failed:2", "--remove-label", "station:sona/oven", "--assignee", "sona/desk", "--status", "open", "--json",
  ]);
  const applied = k.log().find((line) => line.step === "passes" && line.pass);
  assert.deepEqual({ word: applied?.word, applied: applied?.applied, station: applied?.station }, { word: "retry sona/desk", applied: "retry", station: "sona/desk" });
  assert.equal(k.claude().length, 0, "the desk is not a station of this host: the phase waits for its expeditor");
});

test("the word stop closes the order's open phases and then the order with the word as reason, under the expeditor, and labels the pass applied", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    NO_GATES,
    closedPasses(pass("kitchen-22", "turn failed: reproduce", "stop")),
    behind("kitchen-22", phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:2"] })),
    children("kitchen-20", phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:2"] }), phase("kitchen-24", "kitchen-20", "review", "oven")),
    closed("kitchen-21"),
    closed("kitchen-24"),
    closed("kitchen-20"),
    updated("kitchen-22"),
    ready("oven"),
    held(),
    running("oven"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().filter((argv) => argv[2] === "close" || argv[2] === "update"), [
    [...EXPEDITOR, "close", "kitchen-21", "--reason", "stop", "--json"],
    [...EXPEDITOR, "close", "kitchen-24", "--reason", "stop", "--json"],
    [...EXPEDITOR, "close", "kitchen-20", "--reason", "stop", "--json"],
    [...EXPEDITOR, "update", "kitchen-22", "--add-label", "applied", "--json"],
  ]);
  const applied = k.log().find((line) => line.step === "passes" && line.pass);
  assert.deepEqual({ applied: applied?.applied, order: applied?.order, closed: applied?.closed }, { applied: "stop", order: "kitchen-20", closed: ["kitchen-21", "kitchen-24", "kitchen-20"] });
});

test("any other word leaves the pass closed and the order open, with a note on the order saying the human continues by hand, and labels the pass applied", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    NO_GATES,
    closedPasses(pass("kitchen-22", "rounds reached: review", "ship it as is")),
    behind("kitchen-22", phase("kitchen-21", "kitchen-20", "review", "oven")),
    updated("kitchen-20"),
    updated("kitchen-22"),
    ready("oven"),
    held(),
    running("oven"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().filter((argv) => argv[2] === "close" || argv[2] === "update"), [
    [...EXPEDITOR, "update", "kitchen-20", "--append-notes", 'kitchen-22 (rounds reached: review) closed with "ship it as is", neither retry nor stop: the order stays open for sona to continue by hand', "--json"],
    [...EXPEDITOR, "update", "kitchen-22", "--add-label", "applied", "--json"],
  ]);
  const applied = k.log().find((line) => line.step === "passes" && line.pass);
  assert.deepEqual({ word: applied?.word, applied: applied?.applied, order: applied?.order }, { word: "ship it as is", applied: "note", order: "kitchen-20" });
});

test("retry followed by anything but a station title (retry later) is some other word: the note, no reopen", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    NO_GATES,
    closedPasses(pass("kitchen-22", "turn failed: reproduce", "retry later")),
    behind("kitchen-22", phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:2"] })),
    updated("kitchen-20"),
    updated("kitchen-22"),
    ready("oven"),
    held(),
    running("oven"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().filter((argv) => argv[2] === "update").map((argv) => argv.slice(2, 5)), [
    ["update", "kitchen-20", "--append-notes"],
    ["update", "kitchen-22", "--add-label"],
  ]);
  assert.equal(k.log().find((line) => line.step === "passes" && line.pass)?.applied, "note");
});

test("retry on a no station for pass, which blocks its order with no phase laid behind it, reopens nothing and notes on the order that the phase is laid by hand", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    NO_GATES,
    closedPasses(pass("kitchen-32", "no station for reproduce", "retry sona/oven", { parent: "kitchen-30" })),
    behind("kitchen-32", { id: "kitchen-30", title: "Stale cookie", status: "open", issue_type: "epic", labels: ["loop"] }),
    updated("kitchen-30"),
    updated("kitchen-32"),
    ready("oven"),
    held(),
    running("oven"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().filter((argv) => argv[2] === "update"), [
    [...EXPEDITOR, "update", "kitchen-30", "--append-notes", 'kitchen-32 (no station for reproduce) closed with "retry sona/oven", but no phase is laid behind the pass: the order stays open for sona to continue by hand', "--json"],
    [...EXPEDITOR, "update", "kitchen-32", "--add-label", "applied", "--json"],
  ]);
  const applied = k.log().find((line) => line.step === "passes" && line.pass);
  assert.deepEqual({ applied: applied?.applied, phases: applied?.phases, station: applied?.station }, { applied: "retry", phases: [], station: "sona/oven" });
});

test("a pass already labelled applied is skipped, as is a closed pass a recipe laid: the same tick run twice applies the word once", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    NO_GATES,
    closedPasses(
      pass("kitchen-22", "turn failed: reproduce", "retry"),
      pass("kitchen-32", "no station for reproduce", "retry", { parent: "kitchen-30", labels: ["applied"] }),
      pass("kitchen-42", "ship: Stale cookie", "yes", { parent: "kitchen-40" }),
    ),
    behind("kitchen-22", phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:2"] })),
    updated("kitchen-21"),
    updated("kitchen-22"),
    ready("oven"),
    held(),
    running("oven"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));
  k.table.unshift(closedPasses(pass("kitchen-22", "turn failed: reproduce", "retry", { labels: ["applied"] })));
  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().filter((argv) => argv[2] === "update" || argv[2] === "dep"), [
    [...EXPEDITOR, "dep", "list", "kitchen-22", "--direction", "up", "--type", "blocks", "--json"],
    [...EXPEDITOR, "update", "kitchen-21", "--remove-label", "failed:2", "--status", "open", "--json"],
    [...EXPEDITOR, "update", "kitchen-22", "--add-label", "applied", "--json"],
  ], "one apply over two ticks");
  assert.deepEqual(k.log().filter((line) => line.step === "passes" && line.applied instanceof Array).map((line) => line.applied), [["kitchen-22"], []]);
  assert.deepEqual(k.log().filter((line) => line.step === "passes" && line.skipped).map((line) => [line.pass, line.skipped]), [
    ["kitchen-32", "applied already"],
    ["kitchen-42", "not a pass Kitchen laid: its turn applies the word"],
    ["kitchen-22", "applied already"],
  ], "the first two at the first run, the applied pass at the second");
});

test("retry on a phase whose station is attended leaves that phase waiting: no take, no claim, no session", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "desk", { attended: true })),
    NO_GATES,
    closedPasses(pass("kitchen-22", "turn failed: grill", "retry")),
    behind("kitchen-22", phase("kitchen-21", "kitchen-20", "grill", "desk", { labels: ["failed:2"] })),
    updated("kitchen-21"),
    updated("kitchen-22"),
    ready("desk", phase("kitchen-21", "kitchen-20", "grill", "desk")),
    held(),
    running("desk"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.equal(k.claude().length, 0);
  assert.ok(!k.bd().some((argv) => argv.includes("--claim")));
  assert.deepEqual(k.bd().at(-1), [...EXPEDITOR, "update", "kitchen-21", "--add-label", "waiting", "--json"]);
  assert.deepEqual(k.log().find((line) => line.step === "attended" && line.phase)?.waiting, "kitchen turn kitchen-21");
});

test("a pass whose word bd refuses to apply is logged and left unlabelled, so the next tick tries again; the tick goes on", async (t) => {
  const k = kitchen(t, [
    stations(station("kitchen-10", "oven")),
    NO_GATES,
    closedPasses(pass("kitchen-22", "turn failed: reproduce", "retry")),
    behind("kitchen-22", phase("kitchen-21", "kitchen-20", "reproduce", "oven", { labels: ["failed:2"] })),
    { command: "bd", args: [...EXPEDITOR, "update", "kitchen-21"], stderr: "Error: issue kitchen-21 is claimed by sona/oven\n", exitCode: 1 },
    ready("oven"),
    held(),
    running("oven"),
    ...SETTLED,
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.ok(!k.bd().some((argv) => argv[3] === "kitchen-22" && argv[2] === "update"), "the pass is not labelled applied");
  const line = k.log().find((entry) => entry.step === "passes" && entry.pass);
  assert.match(String(line?.failed), /claimed by sona\/oven/);
  assert.ok(k.log().some((entry) => entry.step === "dispatch"), "the tick ran to its end");
});
