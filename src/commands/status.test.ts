// kitchen status, exercised through the CLI: the expeditor's state file and scripted station, phase,
// order and gate beads in; the sections out, reads only, and a plain line when no expeditor runs here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

const OWNER = ["--actor", "sona"];

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[]) {
  const host = initialisedHost(t, table);
  const run = (...argv: string[]) => main(["status", ...argv], host.deps);
  const bd = () => host.runner.calls.filter((c) => c.argv[0] === "bd").map((c) => c.argv.slice(1));
  const stateFile = path.join(host.home, ".local", "state", "kitchen", "expeditor.json");
  /** The state file as `kitchen up --foreground` leaves it; `at` is seconds before the clock's now (2026-01-01T00:00:00Z). */
  const expeditor = (fields: { tick: number; secondsAgo: number; interval?: number; stopped?: string }) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, -fields.secondsAgo)).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: 4242, owner: "sona", host: "sona-laptop", interval: fields.interval ?? 5, started: "2025-12-31T23:00:00.000Z",
      tick: fields.tick, at, ...(fields.stopped ? { stopped: fields.stopped } : {}),
    }));
  };
  return { ...host, run, bd, stateFile, expeditor };
}

const station = (id: string, name: string, cap: number, attended: boolean) => ({
  id, title: `sona/${name}`, status: "open", issue_type: "station",
  labels: ["owner:sona", "host:sona-laptop", `cap:${cap}`, ...(attended ? ["attended"] : [])],
  notes: `offers: ${attended ? "a human at the desk" : "the oven"}\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models: ["claude-opus-5"], auth: "subscription", plugins: [], skills: [],
    repositories: [{ slug: "nomadec/kitchen", path: "/home/sona/src/kitchen" }],
    worktrees: "per-order", cap, budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [],
  })}\n\`\`\``,
});
const phase = (id: string, title: string, order: string, stationName: string, status = "open") => ({
  id, title, status, issue_type: "task", parent: order, assignee: `sona/${stationName}`, labels: [title.split(":")[0] ? `phase:${title.split(":")[0]}` : "", `station:sona/${stationName}`],
});
const order = (id: string, title: string, status = "open") => ({ id, title, status, issue_type: "epic", labels: ["loop"], notes: "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: bug" });
const pass = (id: string, title: string, order: string, brief: string) => ({
  id, title, status: "open", issue_type: "gate", await_type: "human", assignee: "sona", parent: order, description: `Ad-hoc gate blocking ${order}.2\n\nReason: ${brief}`,
});

const stations = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "list", "--type", "station", "--label", "owner:sona", "--label", "host:sona-laptop"], stdout: JSON.stringify(rows) });
const orders = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "list", "--type", "epic", "--label", "loop"], stdout: JSON.stringify(rows) });
const running = (stationName: string, ...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "list", "--assignee", `sona/${stationName}`, "--status", "in_progress"], stdout: JSON.stringify(rows) });
const ready = (stationName: string, ...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "ready", "--assignee", `sona/${stationName}`], stdout: JSON.stringify(rows) });
const gates = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "list", "--type", "gate", "--status", "open"], stdout: JSON.stringify(rows) });

/** Two stations on this host: the oven (unattended, cap 2) running one turn, the desk (attended) with one phase waiting; one open pass. */
const BUSY_HOST: ScriptedAnswer[] = [
  stations(station("kitchen-10", "oven", 2, false), station("kitchen-11", "desk", 1, true)),
  orders(order("kitchen-20", "Stale cookie", "in_progress"), order("kitchen-30", "Cookie jar")),
  running("oven", order("kitchen-20", "Stale cookie", "in_progress"), phase("kitchen-21", "reproduce: Stale cookie", "kitchen-20", "oven", "in_progress")),
  running("desk"),
  ready("desk", phase("kitchen-31", "grill: Cookie jar", "kitchen-30", "desk")),
  gates(pass("kitchen-22", "decide: fix", "kitchen-20", "Two fixes found.\nPick the small one or the right one.")),
];

test("kitchen status renders the expeditor, the running turns, the phases waiting for kitchen turn, the open passes and each station's cap from the state file and bd, reading only", async (t) => {
  const k = kitchen(t, BUSY_HOST);
  k.expeditor({ tick: 12, secondsAgo: 3 });

  const code = await k.run();

  assert.equal(code, 0, k.err.join(""));
  assert.equal(
    k.out.join(""),
    [
      "Expeditor on sona-laptop: running (pid 4242), tick 12 at 2025-12-31T23:59:57.000Z, every 5s, since 2025-12-31T23:00:00.000Z",
      "",
      "Running turns:",
      "  kitchen-21  reproduce: Stale cookie  order kitchen-20 (Stale cookie)  at sona/oven",
      "",
      "Waiting for kitchen turn:",
      "  kitchen-31  grill: Cookie jar  order kitchen-30 (Cookie jar)  at sona/desk",
      "    kitchen turn kitchen-31",
      "",
      "Open passes:",
      "  kitchen-22  decide: fix  order kitchen-20 (Stale cookie)",
      "    Two fixes found.",
      "    Pick the small one or the right one.",
      "",
      "Stations on sona-laptop:",
      "  sona/oven  unattended  1 of 2 running",
      "  sona/desk  attended    0 of 1 running",
      "",
    ].join("\n"),
  );
  assert.deepEqual(k.bd(), [
    [...OWNER, "list", "--type", "station", "--label", "owner:sona", "--label", "host:sona-laptop", "--limit", "0", "--json"],
    [...OWNER, "list", "--type", "epic", "--label", "loop", "--limit", "0", "--json"],
    [...OWNER, "list", "--assignee", "sona/oven", "--status", "in_progress", "--limit", "0", "--json"],
    [...OWNER, "list", "--assignee", "sona/desk", "--status", "in_progress", "--limit", "0", "--json"],
    [...OWNER, "ready", "--assignee", "sona/desk", "--limit", "0", "--json"],
    [...OWNER, "list", "--type", "gate", "--status", "open", "--limit", "0", "--json"],
  ]);
  for (const call of k.runner.calls) assert.deepEqual({ cwd: call.cwd, env: call.env }, k.connection);
});

test("no state file, a clean stop and a stale file each say plainly that the expeditor is not running, and why", async (t) => {
  const quiet: ScriptedAnswer[] = [stations(), orders(), gates()];

  const never = kitchen(t, quiet);
  assert.equal(await never.run(), 0, never.err.join(""));
  assert.equal(never.out[0]?.split("\n")[0], `Expeditor on sona-laptop: not running (no state file at ${never.stateFile}: run kitchen up)`);

  const stopped = kitchen(t, quiet);
  stopped.expeditor({ tick: 40, secondsAgo: 600, stopped: "2025-12-31T23:50:05.000Z" });
  assert.equal(await stopped.run(), 0, stopped.err.join(""));
  assert.equal(stopped.out[0]?.split("\n")[0], "Expeditor on sona-laptop: not running (stopped at 2025-12-31T23:50:05.000Z after tick 40)");

  const stale = kitchen(t, quiet);
  stale.expeditor({ tick: 7, secondsAgo: 16, interval: 5 });
  assert.equal(await stale.run(), 0, stale.err.join(""));
  assert.equal(stale.out[0]?.split("\n")[0], "Expeditor on sona-laptop: not running (pid 4242 last ticked at 2025-12-31T23:59:44.000Z, tick 7, and ticks every 5s: it died or hangs)");

  const alive = kitchen(t, quiet);
  alive.expeditor({ tick: 7, secondsAgo: 15, interval: 5 });
  assert.equal(await alive.run(), 0, alive.err.join(""));
  assert.match(alive.out[0] ?? "", /^Expeditor on sona-laptop: running \(pid 4242\), tick 7/, "three intervals late is the edge of running");

  assert.equal(
    never.out.join("").split("\n").slice(1).join("\n"),
    ["", "Running turns:", "  none", "", "Waiting for kitchen turn:", "  none", "", "Open passes:", "  none", "", "Stations on sona-laptop:", "  none registered: run kitchen station add", ""].join("\n"),
  );
});

test("a host without kitchen init and a bd call that fails are each refused naming the gap; status takes no arguments", async (t) => {
  const k = kitchen(t, []);
  assert.equal(await k.run("--help"), 0);
  assert.match(k.out.at(-1) ?? "", /^Usage: kitchen status/);
  assert.equal(await k.run("oven"), 1);
  assert.match(k.err.at(-1) ?? "", /kitchen status: takes no arguments/);
  fs.rmSync(k.configFile);
  assert.equal(await k.run(), 1);
  assert.match(k.err.at(-1) ?? "", /run kitchen init first/);
  assert.equal(k.runner.calls.length, 0);

  const failing = kitchen(t, [{ command: "bd", args: [...OWNER, "list", "--type", "station"], stderr: "Error: connection refused\n", exitCode: 1 }]);
  assert.equal(await failing.run(), 1);
  assert.match(failing.err.at(-1) ?? "", /kitchen status: bd --actor sona list --type station --label owner:sona --label host:sona-laptop --limit 0 --json failed \(exit 1\): Error: connection refused/);
});
