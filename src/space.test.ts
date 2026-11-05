// The bd wrapper, exercised through the bd calls it issues: the actor on every write, the space
// connection from the host config, and the refusals a station actor meets before any call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { expeditorActor, humanActor, resolveActor, stationActor } from "./actor.ts";
import type { Actor } from "./actor.ts";
import type { HostConfig } from "./config.ts";
import { JournalTruncatedError, openSpace, SpaceError } from "./space.ts";
import { fakeRunner } from "./testing/index.ts";
import type { ScriptedAnswer } from "./testing/index.ts";

const CONFIG: HostConfig = {
  server: { host: "rbn3", port: 3307, user: "sona", database: "kitchen" },
  credential: "/home/sona/.config/beads/credentials",
  owner: "sona",
  host: "sona-laptop",
};
const ENV = { HOME: "/home/sona", XDG_CONFIG_HOME: "/home/sona/.config" };
const SPACE_DIR = path.join("/home/sona/.config", "kitchen", "space");
const CONNECTION = { cwd: SPACE_DIR, env: { BEADS_CREDENTIALS_FILE: CONFIG.credential } };

const CREATED = (id: string, extra = ""): ScriptedAnswer => ({
  command: "bd",
  args: [],
  stdout: `{"id":"${id}","issue_type":"task","status":"open"${extra}}`,
});

function space(actor: Actor, table: readonly ScriptedAnswer[] = []) {
  const runner = fakeRunner(table);
  return { runner, space: openSpace({ runner, env: ENV, config: CONFIG, actor }) };
}

test("a human writes as the owner, a turn as owner/station and the expeditor as owner/expeditor, each over the space connection", async () => {
  const human = space(humanActor("sona"), [CREATED("kitchen-1")]);
  const turn = space(stationActor("sona", "grill"), [CREATED("kitchen-2")]);
  const expeditor = space(expeditorActor("sona"), [CREATED("kitchen-3")]);

  assert.equal((await human.space.create({ title: "order: training venues", type: "epic", labels: ["loop"] })).id, "kitchen-1");
  assert.equal((await turn.space.create({ title: "grill", parent: "kitchen-1", labels: ["phase:grill"] })).id, "kitchen-2");
  assert.equal((await expeditor.space.create({ title: "turn failed: grill", parent: "kitchen-1" })).id, "kitchen-3");

  assert.deepEqual(human.runner.calls, [
    { argv: ["bd", "--actor", "sona", "create", "order: training venues", "--type", "epic", "--labels", "loop", "--json"], ...CONNECTION },
  ]);
  assert.deepEqual(turn.runner.calls, [
    { argv: ["bd", "--actor", "sona/grill", "create", "grill", "--parent", "kitchen-1", "--no-inherit-labels", "--labels", "phase:grill", "--json"], ...CONNECTION },
  ]);
  assert.deepEqual(expeditor.runner.calls, [
    { argv: ["bd", "--actor", "sona/expeditor", "create", "turn failed: grill", "--parent", "kitchen-1", "--no-inherit-labels", "--json"], ...CONNECTION },
  ]);
});

const REGISTERED = (id: string, type: string) => ({ id, title: `${type} ${id}`, status: "open", issue_type: type });
const PASS = { id: "kitchen-1.2", title: "pass: grill", status: "open", issue_type: "gate", await_type: "human" };
const PHASE_LAID = { id: "kitchen-1.1", title: "grill", status: "open", issue_type: "task" };

test("a station is refused, before any bd call, when it tries to create a phase, station or source bead", async () => {
  const { space: s, runner } = space(stationActor("sona", "grill"));
  for (const type of ["phase", "station", "source"]) {
    await assert.rejects(
      () => s.create({ title: `${type} by a turn`, type }),
      (error: Error) => {
        assert.equal(error.name, "RefusedError");
        assert.match(error.message, new RegExp(`sona/grill may not create a ${type} bead`));
        assert.match(error.message, /registering .* is a human act/);
        assert.match(error.message, /cooperative rule/);
        return true;
      },
    );
  }
  assert.deepEqual(runner.calls, []);
});

test("a station is refused, before any bd call, when it edits a phase, station or source bead it read", async () => {
  const { space: s, runner } = space(stationActor("sona", "grill"));
  await assert.rejects(() => s.update(REGISTERED("kitchen-7", "phase"), { addLabels: ["superseded"] }), /sona\/grill may not edit a phase bead/);
  await assert.rejects(() => s.update(REGISTERED("kitchen-8", "station"), { title: "sona/grill" }), /may not edit a station bead/);
  await assert.rejects(() => s.setNote(REGISTERED("kitchen-9", "source"), "cursor", "42"), /may not edit a source bead/);
  assert.deepEqual(runner.calls, []);
});

test("a station is refused, before any bd call, when it closes a pass; closing its own phase goes through", async () => {
  const { space: s, runner } = space(stationActor("sona", "grill"), [{ command: "bd", args: ["--actor", "sona/grill", "close"], stdout: "[]" }]);
  await assert.rejects(
    () => s.close(PASS, "yes"),
    (error: Error) => {
      assert.equal(error.name, "RefusedError");
      assert.match(error.message, /sona\/grill may not close the pass kitchen-1\.2/);
      assert.match(error.message, /a pass closes only under a person's name/);
      assert.match(error.message, /cooperative rule/);
      return true;
    },
  );
  assert.equal(runner.calls.length, 0, "no call was issued for the refused close");

  await s.close(PHASE_LAID, "https://github.com/nomadec/kitchen/pull/9");
  assert.deepEqual(runner.calls.map((c) => c.argv), [
    ["bd", "--actor", "sona/grill", "close", "kitchen-1.1", "--reason", "https://github.com/nomadec/kitchen/pull/9", "--json"],
  ]);
});

test("a station is refused the same way when it closes a pass through an update of its status, which is a close by another name", async () => {
  const { space: s, runner } = space(stationActor("sona", "grill"), [{ command: "bd", args: ["--actor", "sona/grill", "update"], stdout: "[]" }]);
  await assert.rejects(() => s.update(PASS, { status: "closed" }), /sona\/grill may not close the pass kitchen-1\.2/);
  assert.equal(runner.calls.length, 0, "no call was issued for the refused close");

  await s.update(PASS, { addLabels: ["briefed"] });
  await s.update(PHASE_LAID, { status: "closed" });
  assert.deepEqual(runner.calls.map((c) => c.argv), [
    ["bd", "--actor", "sona/grill", "update", "kitchen-1.2", "--add-label", "briefed", "--json"],
    ["bd", "--actor", "sona/grill", "update", "kitchen-1.1", "--status", "closed", "--json"],
  ]);
});

test("the expeditor may keep a source's cursor but, like a station, may not close a pass", async () => {
  const { space: s, runner } = space(expeditorActor("sona"), [
    { command: "bd", args: ["--actor", "sona/expeditor", "show", "kitchen-9"], stdout: '[{"id":"kitchen-9","issue_type":"source","status":"open","notes":"cursor: 41"}]' },
    { command: "bd", args: ["--actor", "sona/expeditor", "update"], stdout: "[]" },
  ]);
  await s.setNote(REGISTERED("kitchen-9", "source"), "cursor", "42");
  assert.deepEqual(runner.calls.map((c) => c.argv), [
    ["bd", "--actor", "sona/expeditor", "show", "kitchen-9", "--json"],
    ["bd", "--actor", "sona/expeditor", "update", "kitchen-9", "--notes", "cursor: 42", "--json"],
  ]);
  await assert.rejects(() => s.close(PASS, "yes"), /sona\/expeditor may not close the pass/);
  assert.equal(runner.calls.length, 2, "the refused close issued nothing");
});

test("a station closing a gate it did not read the type of has it read first, and is refused when it is a pass", async () => {
  const { space: s, runner } = space(stationActor("sona", "grill"), [
    { command: "bd", args: ["--actor", "sona/grill", "show", "kitchen-1.2"], stdout: JSON.stringify([PASS]) },
    { command: "bd", args: ["--actor", "sona/grill", "show", "kitchen-1.5"], stdout: '[{"id":"kitchen-1.5","title":"wait: PR 9","status":"open","issue_type":"gate","await_type":"gh:pr"}]' },
    { command: "bd", args: ["--actor", "sona/grill", "close"], stdout: "[]" },
  ]);
  await assert.rejects(() => s.close({ id: "kitchen-1.2", issue_type: "gate" }, "yes"), /may not close the pass kitchen-1\.2/);
  await s.close({ id: "kitchen-1.5", issue_type: "gate" }, "merged");
  assert.deepEqual(runner.calls.map((c) => c.argv), [
    ["bd", "--actor", "sona/grill", "show", "kitchen-1.2", "--json"],
    ["bd", "--actor", "sona/grill", "show", "kitchen-1.5", "--json"],
    ["bd", "--actor", "sona/grill", "close", "kitchen-1.5", "--reason", "merged", "--json"],
  ]);
});

test("the same calls under a human actor go through to bd", async () => {
  const { space: s, runner } = space(humanActor("sona"), [
    { command: "bd", args: ["--actor", "sona", "create"], stdout: '{"id":"kitchen-7","issue_type":"phase","status":"open"}' },
    { command: "bd", args: ["--actor", "sona", "update"], stdout: "[]" },
    { command: "bd", args: ["--actor", "sona", "show", "kitchen-9"], stdout: '[{"id":"kitchen-9","issue_type":"source","status":"open","notes":"cursor: 41\\nrecipe: umka"}]' },
    { command: "bd", args: ["--actor", "sona", "close"], stdout: "[]" },
  ]);

  await s.create({ title: "umka/grill", type: "phase", labels: ["rev:ab12cd"], description: "---\nphase: grill\n---\n" });
  await s.update(REGISTERED("kitchen-7", "phase"), { addLabels: ["superseded"] });
  await s.setNote(REGISTERED("kitchen-9", "source"), "cursor", "42");
  await s.close(PASS, "ship it");

  assert.deepEqual(runner.calls.map((c) => c.argv), [
    ["bd", "--actor", "sona", "create", "umka/grill", "--type", "phase", "--labels", "rev:ab12cd", "--description", "---\nphase: grill\n---\n", "--json"],
    ["bd", "--actor", "sona", "update", "kitchen-7", "--add-label", "superseded", "--json"],
    ["bd", "--actor", "sona", "show", "kitchen-9", "--json"],
    ["bd", "--actor", "sona", "update", "kitchen-9", "--notes", "cursor: 42\nrecipe: umka", "--json"],
    ["bd", "--actor", "sona", "close", "kitchen-1.2", "--reason", "ship it", "--json"],
  ]);
  assert.ok(runner.calls.every((c) => c.cwd === SPACE_DIR && c.env?.BEADS_CREDENTIALS_FILE === CONFIG.credential), "every call runs over the space connection");
});

test("the helpers later slices build on are thin argv builders over bd 1.3.1", async () => {
  const { space: s, runner } = space(stationActor("sona", "grill"), [
    { command: "bd", args: ["--actor", "sona/grill", "dep", "add"] },
    { command: "bd", args: ["--actor", "sona/grill", "ready"], stdout: '[{"id":"kitchen-1.1","title":"grill","status":"open","issue_type":"task","assignee":"sona/grill"}]' },
    { command: "bd", args: ["--actor", "sona/grill", "list"], stdout: '[{"id":"kitchen-7","title":"umka/grill","status":"open","issue_type":"phase","labels":["rev:ab12cd"],"description":"---\\nphase: grill\\n---\\n"}]' },
    { command: "bd", args: ["--actor", "sona/grill", "show", "kitchen-1"], stdout: '[{"id":"kitchen-1","title":"order","status":"open","issue_type":"epic","notes":"repos: nomadec/kitchen\\nrecipe: umka rev:ab12cd\\nclass: idea"}]' },
    { command: "bd", args: ["--actor", "sona/grill", "gate", "create"], stdout: '{"id":"kitchen-1.2","title":"pass: grill","status":"open","issue_type":"gate","await_type":"human"}' },
    { command: "bd", args: ["--actor", "sona/grill", "gate", "list"], stdout: '[{"id":"kitchen-1.2","title":"pass: grill","status":"open","issue_type":"gate","await_type":"human"}]' },
    { command: "bd", args: ["--actor", "sona/grill", "gate", "check"], stdout: "[]" },
    { command: "bd", args: ["--actor", "sona/grill", "events", "tail"], stdout: '{"seq":41,"op":"create","issue_id":"kitchen-1.1"}\n{"seq":42,"op":"close","issue_id":"kitchen-1.1"}\n' },
  ]);

  await s.addDependency("kitchen-1.3", "kitchen-1.1");
  assert.deepEqual((await s.ready({ assignee: "sona/grill", labels: ["phase:grill"] })).map((b) => b.id), ["kitchen-1.1"]);
  assert.deepEqual((await s.list({ type: "phase", labels: ["rev:ab12cd"] })).map((b) => b.description), ["---\nphase: grill\n---\n"]);
  assert.equal((await s.show("kitchen-1")).title, "order");
  assert.equal(await s.readNote("kitchen-1", "class"), "idea");
  assert.equal(await s.readNote("kitchen-1", "worktree"), undefined);
  const pass = await s.layGate({ blocks: "kitchen-1.3", type: "human", title: "pass: grill", reason: "Approve the grill?" });
  assert.equal(pass.id, "kitchen-1.2");
  assert.deepEqual((await s.gates()).map((g) => g.id), ["kitchen-1.2"]);
  await s.checkGates("gh:pr");
  assert.deepEqual((await s.events(40)).map((e) => e.seq), [41, 42]);

  assert.deepEqual(runner.calls.map((c) => c.argv), [
    ["bd", "--actor", "sona/grill", "dep", "add", "kitchen-1.3", "kitchen-1.1"],
    ["bd", "--actor", "sona/grill", "ready", "--assignee", "sona/grill", "--label", "phase:grill", "--limit", "0", "--json"],
    ["bd", "--actor", "sona/grill", "list", "--type", "phase", "--label", "rev:ab12cd", "--limit", "0", "--json"],
    ["bd", "--actor", "sona/grill", "show", "kitchen-1", "--json"],
    ["bd", "--actor", "sona/grill", "show", "kitchen-1", "--json"],
    ["bd", "--actor", "sona/grill", "show", "kitchen-1", "--json"],
    ["bd", "--actor", "sona/grill", "gate", "create", "--type", "human", "--blocks", "kitchen-1.3", "--title", "pass: grill", "--reason", "Approve the grill?", "--json"],
    ["bd", "--actor", "sona/grill", "gate", "list", "--limit", "0", "--json"],
    ["bd", "--actor", "sona/grill", "gate", "check", "--type", "gh:pr", "--json"],
    ["bd", "--actor", "sona/grill", "events", "tail", "--since", "40", "--json"],
  ]);
});

test("a journal read below the retention floor is a JournalTruncatedError naming bd's floor and head; any other failure stays a SpaceError", async () => {
  const truncated = JSON.stringify({ code: "events_journal_truncated", error: "events journal truncated: checkpoint 0 is below the retained window [3..5]; records 1..2 were pruned", floor: 3, head: 5, schema_version: 1, since: 0 });
  const { space: s } = space(humanActor("sona"), [
    { command: "bd", args: ["--actor", "sona", "events", "tail", "--since", "0"], exitCode: 1, stdout: truncated },
    { command: "bd", args: ["--actor", "sona", "events", "tail", "--since", "9"], exitCode: 1, stderr: "Error: events journal is not enabled" },
  ]);
  await assert.rejects(() => s.events(0), (error: unknown) => error instanceof JournalTruncatedError && error.floor === 3 && error.head === 5);
  await assert.rejects(() => s.events(9), (error: unknown) => error instanceof SpaceError && !(error instanceof JournalTruncatedError) && /not enabled/.test(error.message));
});

test("a bd call that fails surfaces its argv and stderr", async () => {
  const { space: s } = space(humanActor("sona"), [
    { command: "bd", args: ["--actor", "sona", "close"], exitCode: 1, stderr: "Error: issue kitchen-9 not found\n" },
  ]);
  await assert.rejects(() => s.close(PHASE_LAID, "done"), (error: Error) => {
    assert.equal(error.name, "SpaceError");
    assert.match(error.message, /bd --actor sona close kitchen-1\.1 .*issue kitchen-9 not found/);
    return true;
  });
});

test("the actor is resolved from the context: BEADS_ACTOR in a session the runner started, else the host config's owner", async () => {
  const contexts: [Record<string, string>, string][] = [
    [{}, "sona"],
    [{ BEADS_ACTOR: "sona/grill" }, "sona/grill"],
    [{ BEADS_ACTOR: "sona/expeditor" }, "sona/expeditor"],
  ];
  for (const [sessionEnv, expected] of contexts) {
    const env = { ...ENV, ...sessionEnv };
    const runner = fakeRunner([{ command: "bd", args: ["--actor", expected, "create"], stdout: '{"id":"kitchen-1.4","issue_type":"task","status":"open"}' }]);
    const s = openSpace({ runner, env, config: CONFIG, actor: resolveActor(env, CONFIG) });
    await s.create({ title: "review", parent: "kitchen-1" });
    assert.deepEqual(runner.calls[0]?.argv.slice(0, 3), ["bd", "--actor", expected]);
  }
});
