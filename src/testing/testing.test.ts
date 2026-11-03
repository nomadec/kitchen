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

test("a fake clock wakes sleepers in due order, the earliest first, and an aborted sleep is forgotten", async () => {
  const clock = fakeClock(new Date("2026-11-03T09:00:00Z"));
  const woke: string[] = [];
  const later = clock.sleep(3_000).then(() => woke.push(`later at ${clock.now().toISOString()}`));
  const sooner = clock.sleep(1_000).then(() => woke.push(`sooner at ${clock.now().toISOString()}`));
  const stopper = new AbortController();
  const never = clock.sleep(2_000, { signal: stopper.signal }).then(() => woke.push("never"), (error: Error) => woke.push(error.name));
  stopper.abort();
  await Promise.all([later, sooner, never]);
  assert.deepEqual(woke, ["AbortError", "sooner at 2026-11-03T09:00:01.000Z", "later at 2026-11-03T09:00:03.000Z"]);
});

test("a fake runner row that lasts answers once that long has passed on the clock, or as a killed child when its signal aborts first", async () => {
  const clock = fakeClock(new Date("2026-11-03T09:00:00Z"));
  const runner = fakeRunner([{ command: "claude", args: [], stdout: "done\n", lasts: 90_000 }], clock);

  const result = await runner(["claude", "--print"]);
  assert.deepEqual(result, { stdout: "done\n", stderr: "", exitCode: 0 });
  assert.equal(clock.now().toISOString(), "2026-11-03T09:01:30.000Z");

  const killer = new AbortController();
  const killed = runner(["claude", "--print"], { signal: killer.signal });
  await clock.sleep(10_000);
  killer.abort();
  assert.deepEqual(await killed, { stdout: "", stderr: "", exitCode: 128 });
  assert.equal(clock.now().toISOString(), "2026-11-03T09:01:40.000Z", "the killed child's wake was forgotten, not slept out");
});
