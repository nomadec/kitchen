// The fake runner and fake clock every slice tests through: scripted answers in, recorded calls out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeClock, fakeRunner } from "./index.ts";

test("a fake runner answers bd, git, gh and claude from its table and records every call", async () => {
  const runner = fakeRunner([
    { command: "bd", args: ["ready", "--json"], stdout: "[]" },
    { command: "git", args: ["fetch", "origin"] },
    { command: "gh", args: ["pr", "view", "12"], stdout: '{"state":"MERGED"}' },
    { command: "claude", args: ["--print"], stderr: "over budget", exitCode: 3 },
  ]);

  assert.deepEqual(await runner(["bd", "ready", "--json"]), { stdout: "[]", stderr: "", exitCode: 0 });
  assert.deepEqual(await runner(["git", "fetch", "origin"], { cwd: "/repo" }), { stdout: "", stderr: "", exitCode: 0 });
  assert.equal((await runner(["gh", "pr", "view", "12"])).stdout, '{"state":"MERGED"}');
  assert.deepEqual(await runner(["claude", "--print"], { env: { BEADS_ACTOR: "sona/grill" } }), {
    stdout: "",
    stderr: "over budget",
    exitCode: 3,
  });

  assert.deepEqual(runner.calls, [
    { argv: ["bd", "ready", "--json"] },
    { argv: ["git", "fetch", "origin"], cwd: "/repo" },
    { argv: ["gh", "pr", "view", "12"] },
    { argv: ["claude", "--print"], env: { BEADS_ACTOR: "sona/grill" } },
  ]);
});

test("a fake runner matches a row by a leading prefix of the argv, so flags after it are free", async () => {
  const runner = fakeRunner([{ command: "bd", args: ["show"], stdout: "shown" }]);
  assert.equal((await runner(["bd", "show", "ord-1", "--json"])).stdout, "shown");
});

test("a fake runner refuses a call its table does not script", async () => {
  const runner = fakeRunner([{ command: "bd", args: ["ready"] }]);
  await assert.rejects(() => runner(["bd", "list"]), /Unexpected command: bd list/);
  assert.equal(runner.calls.length, 1, "the refused call is still recorded");
});

test("a fake clock stands still until advanced, and sleeping advances it", async () => {
  const clock = fakeClock(new Date("2026-11-03T09:00:00Z"));
  assert.equal(clock.now().toISOString(), "2026-11-03T09:00:00.000Z");
  assert.equal(clock.now().toISOString(), "2026-11-03T09:00:00.000Z");
  clock.advance(60_000);
  assert.equal(clock.now().toISOString(), "2026-11-03T09:01:00.000Z");
  await clock.sleep(1_500);
  assert.equal(clock.now().toISOString(), "2026-11-03T09:01:01.500Z");
});
