// The Stop hook of the Kitchen plugin, exercised the way Claude Code runs it: the Stop event on
// stdin, a block decision on stdout while a background task the turn started still runs (keep-alive),
// and nothing when the session is free to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hook = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "plugin", "hooks", "stop-guard.mjs");

const stop = (event: unknown, script = hook) =>
  spawnSync(process.execPath, [script], { input: typeof event === "string" ? event : JSON.stringify(event), encoding: "utf8" });

const task = (status: string, fields: Record<string, string> = {}) => ({ id: "b1", type: "shell", status, ...fields });

test("keep-alive: a running background command blocks the stop, names the command and says to wait in the foreground", () => {
  const r = stop({ hook_event_name: "Stop", stop_hook_active: false, background_tasks: [task("running", { command: "npm test > /tmp/suite.log", description: "the suite" })] });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { decision: string; reason: string };
  assert.equal(out.decision, "block");
  assert.match(out.reason, /still running \(1\)/);
  assert.match(out.reason, /- shell: npm test > \/tmp\/suite\.log/);
  assert.match(out.reason, /Wait for it in the foreground/);
});

test("keep-alive: a pending subagent counts as work in flight and is named by its description", () => {
  const r = stop({ background_tasks: [{ id: "a1", type: "subagent", status: "pending", description: "code review", agent_type: "Explore" }] });
  const out = JSON.parse(r.stdout) as { decision: string; reason: string };
  assert.equal(out.decision, "block");
  assert.match(out.reason, /- subagent: code review/);
});

test("free to end: nothing in flight, a finished task, or no task list at all lets the turn end with nothing printed", () => {
  for (const event of [
    { hook_event_name: "Stop", stop_hook_active: false, background_tasks: [] },
    { hook_event_name: "Stop", stop_hook_active: false },
    { background_tasks: [task("completed", { description: "done" }), task("failed")] },
  ]) {
    const r = stop(event);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  }
});

test("free to end: an event that is not JSON, or an empty one, never blocks", () => {
  for (const raw of ["not json", ""]) {
    const r = stop(raw);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  }
});

test("the hook runs as main when reached through a symlink, as a plugin cache may hold it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-stop-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, "stop-guard.mjs");
  fs.symlinkSync(hook, link);
  const r = stop({ background_tasks: [task("backgrounded", { command: "sleep 9" })] }, link);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((JSON.parse(r.stdout) as { decision: string }).decision, "block");
});
