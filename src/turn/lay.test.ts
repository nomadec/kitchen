// The lay helper the turn driver calls for the mechanical parts of a close-out, exercised through the
// bd calls it issues under the turn actor: a phase bead with its labels and the copied phase text, a
// pass with its brief, a dependency, an assignment, a close; and what it refuses before any write.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeHostConfig } from "../config.ts";
import { fakeRunner } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";
import { lay } from "./lay.ts";

const TURN = ["--actor", "sona/oven"];

interface Scope {
  after(fn: () => void): void;
}

/** A session the runner started: BEADS_ACTOR names the station; `null` leaves it unset. */
function turn(t: Scope, table: readonly ScriptedAnswer[], actor: string | null = "sona/oven", stdin?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-lay-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), BEADS_ACTOR: actor ?? undefined };
  writeHostConfig(env, {
    server: { host: "rbn3", port: 3307, user: "sona", database: "kitchen" },
    credential: "/home/sona/.config/beads/credentials",
    owner: "sona",
    host: "sona-laptop",
  });
  const out: string[] = [];
  const err: string[] = [];
  const runner = fakeRunner(table);
  return {
    out, err, runner,
    run: (...argv: string[]) =>
      lay(argv, { runner, env, stdout: (s) => out.push(s), stderr: (s) => err.push(s), ...(stdin === undefined ? {} : { stdin: async () => stdin }) }),
    /** The argv of every bd call, after `bd --actor sona/oven`. */
    bd: () => runner.calls.filter((c) => c.argv[0] === "bd").map((c) => c.argv.slice(3)),
    writes: () => runner.calls.filter((c) => c.argv[0] === "bd" && !["show", "list"].includes(c.argv[3] ?? "")),
  };
}

const PHASE = (slug: string, extra = "", from = "[]", to = "[]") =>
  `---\nphase: ${slug}\nskill: umka:${slug}\nfrom: ${from}\nto: ${to}\nartifact: a PR\nmodel: claude-opus-5\n${extra}budget:\n  usd: 5\n  effort: high\n---\n# ${slug}\n`;
const PASS = (slug: string) => `---\nphase: ${slug}\nskill: human\nfrom: [spec]\nto: [slice]\nartifact: the pass is closed\nask: the spec URL\n---\n# ${slug}\n`;

const registered = (...phases: { slug: string; text: string; recipe?: string; rev?: string }[]) =>
  phases.map((p, i) => ({
    id: `kitchen-${i + 1}`, title: `${p.recipe ?? "umka"}/${p.slug}`, status: "open", issue_type: "phase",
    labels: [`rev:${p.rev ?? "a1b2c3d"}`, ...(p.rev === "old1234" ? ["superseded"] : [])],
    description: p.text,
  }));

const station = (id: string, name: string, models: string[], repos: string[]) => ({
  id, title: `sona/${name}`, status: "open", issue_type: "station",
  labels: ["owner:sona", "host:sona-laptop", "cap:2"],
  notes: `offers: ${repos.join(" and ")} checked out\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models, auth: "subscription", plugins: [], skills: [],
    repositories: repos.map((slug) => ({ slug, path: `/home/sona/src/${slug.split("/")[1]}` })),
    worktrees: "per-order", cap: 2, budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [],
  })}\n\`\`\``,
});

const order = (recipe = "umka rev:a1b2c3d"): ScriptedAnswer => ({
  command: "bd", args: [...TURN, "show", "kitchen-20"],
  stdout: JSON.stringify([{ id: "kitchen-20", title: "Stale cookie", status: "in_progress", issue_type: "epic", labels: ["loop"], notes: `repos: nomadec/kitchen\nrecipe: ${recipe}\nclass: ticket` }]),
});
const phases = (rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...TURN, "list", "--type", "phase"], stdout: JSON.stringify(rows) });
const stations = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...TURN, "list", "--type", "station"], stdout: JSON.stringify(rows) });
const children = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...TURN, "list", "--parent", "kitchen-20", "--all"], stdout: JSON.stringify(rows) });
const created = (id: string, title: string, type = "task"): ScriptedAnswer => ({
  command: "bd", args: [...TURN, "create", title], stdout: JSON.stringify({ id, title, status: "open", issue_type: type }),
});
const child = (id: string, slug: string, status: string, title = `${slug}: Stale cookie`) => ({
  id, title, status, issue_type: "task", parent: "kitchen-20", assignee: "sona/oven", labels: [`phase:${slug}`, "station:sona/oven"], notes: "model: claude-opus-5",
});

const UMKA = registered({ slug: "implement", text: PHASE("implement", "", "[source]", "[pr]") }, { slug: "pr", text: PHASE("pr", "", "[implement, fix]", "[review]") }, { slug: "approve-spec", text: PASS("approve-spec") });
const OVEN = station("kitchen-10", "oven", ["claude-opus-5"], ["nomadec/kitchen"]);

test("lay phase: the phase bead of the order's pinned revision, with the phase and station labels, the model note, the reason, the copied phase text, the assignee and the blocking edge", async (t) => {
  const k = turn(t, [order(), phases(UMKA), stations(OVEN), children(child("kitchen-21", "implement", "in_progress")), created("kitchen-22", "pr: Stale cookie")]);

  const code = await k.run("phase", "kitchen-20", "pr", "--station", "sona/oven", "--why", "offers the kitchen checkout and gh", "--blocked-by", "kitchen-21");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.bd(), [
    ["show", "kitchen-20", "--json"],
    ["list", "--type", "phase", "--limit", "0", "--json"],
    ["list", "--type", "station", "--limit", "0", "--json"],
    ["list", "--parent", "kitchen-20", "--all", "--limit", "0", "--json"],
    [
      "create", "pr: Stale cookie",
      "--type", "task",
      "--parent", "kitchen-20", "--no-inherit-labels",
      "--labels", "phase:pr,station:sona/oven",
      "--notes", "model: claude-opus-5\nassigned: offers the kitchen checkout and gh",
      "--description", PHASE("pr", "", "[implement, fix]", "[review]"),
      "--assignee", "sona/oven",
      "--deps", "blocked-by:kitchen-21",
      "--json",
    ],
  ]);
  for (const call of k.runner.calls) {
    assert.deepEqual(call.argv.slice(0, 3), ["bd", "--actor", "sona/oven"], "every call is under the turn actor");
    assert.ok(call.cwd?.endsWith(path.join(".config", "kitchen", "space")), "every call runs in the space the host config names");
    assert.deepEqual(call.env, { BEADS_CREDENTIALS_FILE: "/home/sona/.config/beads/credentials" });
  }
  assert.equal(k.out.join(""), "Laid pr as kitchen-22 at sona/oven, blocked by kitchen-21\n");
});

test("lay phase: a qualifier after --title names the item of a fan-out; an open sibling whose phase the new phase lists under from blocks it too; a note line is added", async (t) => {
  const k = turn(t, [
    order(), phases(UMKA), stations(OVEN),
    children(child("kitchen-21", "implement", "closed"), child("kitchen-23", "fix", "open", "fix: the cookie"), child("kitchen-24", "review", "open", "review: round 1")),
    created("kitchen-25", "pr: round 2"),
    { command: "bd", args: [...TURN, "dep", "add", "kitchen-25", "kitchen-23"] },
  ]);

  const code = await k.run("phase", "kitchen-20", "pr", "--station", "sona/oven", "--why", "same station", "--blocked-by", "kitchen-21", "--title", "round 2", "--note", "skipped: approve-spec: skip when the spec is unchanged; the spec is unchanged");

  assert.equal(code, 0, k.err.join(""));
  const create = k.bd().find((argv) => argv[0] === "create");
  assert.equal(create?.[1], "pr: round 2");
  assert.equal(create?.[create.indexOf("--notes") + 1], "model: claude-opus-5\nassigned: same station\nskipped: approve-spec: skip when the spec is unchanged; the spec is unchanged");
  assert.deepEqual(k.bd().at(-1), ["dep", "add", "kitchen-25", "kitchen-23"], "fix is open and in pr's from; review is not in from; implement is closed");
  assert.equal(k.out.join(""), "Laid pr as kitchen-25 at sona/oven, blocked by kitchen-21, kitchen-23\n");
});

test("lay phase: an open child with the same title is not laid twice; it is made to wait for the blockers instead", async (t) => {
  const k = turn(t, [
    order(), phases(UMKA), stations(OVEN),
    children(child("kitchen-21", "implement", "in_progress"), child("kitchen-22", "pr", "open")),
    { command: "bd", args: [...TURN, "dep", "add", "kitchen-22", "kitchen-21"] },
  ]);

  const code = await k.run("phase", "kitchen-20", "pr", "--station", "sona/oven", "--why", "same station", "--blocked-by", "kitchen-21");

  assert.equal(code, 0, k.err.join(""));
  assert.ok(!k.bd().some((argv) => argv[0] === "create"), "nothing created");
  assert.deepEqual(k.bd().at(-1), ["dep", "add", "kitchen-22", "kitchen-21"]);
  assert.equal(k.out.join(""), "pr is laid already as kitchen-22; it now waits for kitchen-21\n");
});

test("lay phase: a station lacking the model or a repository the order names is refused with the gap, before any write, so the driver lays the no-station pass", async (t) => {
  const k = turn(t, [order(), phases(UMKA), stations(station("kitchen-11", "grill", ["claude-sonnet-5"], ["sona-is/sona"]))]);

  const code = await k.run("phase", "kitchen-20", "pr", "--station", "sona/grill", "--why", "a guess");

  assert.equal(code, 2);
  assert.equal(k.writes().length, 0);
  assert.equal(k.err.join(""), "lay: no station for pr at sona/grill: it lacks model claude-opus-5, nomadec/kitchen\n");
});

test("lay phase: a station that is not registered, and a phase the pinned revision does not hold, are refused before any write", async (t) => {
  const k = turn(t, [order(), phases(UMKA), stations(OVEN)]);
  assert.equal(await k.run("phase", "kitchen-20", "pr", "--station", "sona/toaster", "--why", "x"), 2);
  assert.equal(k.err.join(""), "lay: no station titled sona/toaster is registered\n");

  const j = turn(t, [order(), phases(UMKA), stations(OVEN)]);
  assert.equal(await j.run("phase", "kitchen-20", "deploy", "--station", "sona/oven", "--why", "x"), 2);
  assert.equal(j.err.join(""), "lay: no recipe this order has not pinned holds a phase named deploy (pinned: umka rev:a1b2c3d)\n");
  assert.equal(j.writes().length, 0);
});

test("lay phase: a phase the order's own pinned revision lacks is not read from a newer revision of that recipe, since re-pinning a running order is a human act", async (t) => {
  const newer = registered({ slug: "deploy", text: PHASE("deploy"), rev: "b2c3d4e" });
  const k = turn(t, [order(), phases([...UMKA, ...newer]), stations(OVEN)]);
  assert.equal(await k.run("phase", "kitchen-20", "deploy", "--station", "sona/oven", "--why", "x"), 2);
  assert.equal(k.err.join(""), "lay: no recipe this order has not pinned holds a phase named deploy (pinned: umka rev:a1b2c3d)\n");
  assert.equal(k.writes().length, 0);
});

test("lay phase without --station lays the phase unassigned, with no station: label and the gap as its unassigned: note, for a no station for pass to block and the person's retry <station> to assign", async (t) => {
  const k = turn(t, [order(), phases(UMKA), children(child("kitchen-21", "implement", "in_progress")), created("kitchen-22", "pr: Stale cookie")]);

  const code = await k.run("phase", "kitchen-20", "pr", "--why", "pr needs model claude-opus-5 and gh; sona/oven lacks gh", "--blocked-by", "kitchen-21");

  assert.equal(code, 0, k.err.join(""));
  assert.ok(!k.bd().some((argv) => argv[0] === "list" && argv[2] === "station"), "no station is read: none is checked");
  assert.deepEqual(k.bd().at(-1), [
    "create", "pr: Stale cookie",
    "--type", "task",
    "--parent", "kitchen-20", "--no-inherit-labels",
    "--labels", "phase:pr",
    "--notes", "model: claude-opus-5\nunassigned: pr needs model claude-opus-5 and gh; sona/oven lacks gh",
    "--description", PHASE("pr", "", "[implement, fix]", "[review]"),
    "--deps", "blocked-by:kitchen-21",
    "--json",
  ]);
  assert.equal(k.out.join(""), "Laid pr as kitchen-22 unassigned, blocked by kitchen-21\n");
});

test("lay phase --behind <pass>: the phase is laid blocked by the pass and the rounds cap is passed over, since the person's word on the pass grants the round", async (t) => {
  const review = registered({ slug: "review", text: PHASE("review", "rounds: 2\n", "[pr, address]", "[decide-blocking]") });
  const k = turn(t, [
    order(), phases(review), stations(OVEN),
    children(child("kitchen-26", "review", "closed", "review: round 1"), child("kitchen-27", "review", "closed", "review: round 2")),
    created("kitchen-29", "review: round 3"),
  ]);

  const code = await k.run("phase", "kitchen-20", "review", "--station", "sona/oven", "--why", "x", "--title", "round 3", "--behind", "kitchen-28");

  assert.equal(code, 0, k.err.join(""));
  const create = k.bd().find((argv) => argv[0] === "create");
  assert.deepEqual(create?.slice(-3), ["--deps", "blocked-by:kitchen-28", "--json"]);
  assert.equal(k.out.join(""), "Laid review as kitchen-29 at sona/oven, blocked by kitchen-28\n");
});

test("lay phase: a pass phase is never worked, so laying it as a phase is refused and lay pass is named", async (t) => {
  const k = turn(t, [order(), phases(UMKA), stations(OVEN)]);
  assert.equal(await k.run("phase", "kitchen-20", "approve-spec", "--station", "sona/oven", "--why", "x"), 2);
  assert.equal(k.err.join(""), "lay: approve-spec is a pass phase (skill: human): lay it with lay pass\n");
  assert.equal(k.writes().length, 0);
});

test("lay phase: the rounds cap counts every child of that phase, open or closed, and refuses the one past it with exit 3", async (t) => {
  const review = registered({ slug: "review", text: PHASE("review", "rounds: 2\n", "[pr, address]", "[decide-blocking]") });
  const k = turn(t, [order(), phases(review), stations(OVEN), children(child("kitchen-26", "review", "closed", "review: round 1"), child("kitchen-27", "review", "closed", "review: round 2"))]);

  const code = await k.run("phase", "kitchen-20", "review", "--station", "sona/oven", "--why", "x", "--title", "round 3");

  assert.equal(code, 3);
  assert.equal(k.writes().length, 0);
  assert.equal(k.err.join(""), "lay: rounds reached: review (2 laid, rounds: 2)\n");
});

test("lay phase: an edge into another recipe pins that recipe's latest revision at the front of the order's recipe: note, keeping the earlier pin, before the phase is laid", async (t) => {
  const triage = registered({ slug: "triage", text: PHASE("triage"), recipe: "triage", rev: "f00ba12" }, { slug: "triage", text: PHASE("triage"), recipe: "triage", rev: "old1234" });
  const k = turn(t, [
    order(), phases([...UMKA, ...triage]), stations(OVEN), children(),
    { command: "bd", args: [...TURN, "update", "kitchen-20", "--notes"], stdout: "[]" },
    created("kitchen-28", "triage: Stale cookie"),
  ]);

  const code = await k.run("phase", "kitchen-20", "triage", "--station", "sona/oven", "--why", "x");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.bd()[4], ["update", "kitchen-20", "--notes", "repos: nomadec/kitchen\nrecipe: triage rev:f00ba12, umka rev:a1b2c3d\nclass: ticket", "--json"]);
  const create = k.bd().find((argv) => argv[0] === "create");
  assert.equal(create?.[create.indexOf("--description") + 1], PHASE("triage"));
  assert.equal(k.out.join(""), "Pinned triage rev:f00ba12 on kitchen-20\nLaid triage as kitchen-28 at sona/oven\n");
});

test("lay pass: a human gate with the brief, blocking the phase laid behind it, made the order's child for the owner and labelled with the pass phase", async (t) => {
  const k = turn(t, [
    order(), phases(UMKA),
    { command: "bd", args: [...TURN, "gate", "create"], stdout: JSON.stringify({ id: "kitchen-29", title: "approve spec", status: "open", issue_type: "gate", await_type: "human" }) },
    { command: "bd", args: [...TURN, "update", "kitchen-29"], stdout: "[]" },
  ]);

  const code = await k.run("pass", "kitchen-20", "approve-spec", "--blocks", "kitchen-22", "--brief", "kitchen-29: approve spec\nThe spec is at https://github.com/nomadec/kitchen/issues/7.");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.bd().slice(2), [
    ["gate", "create", "--type", "human", "--blocks", "kitchen-22", "--title", "approve spec", "--reason", "kitchen-29: approve spec\nThe spec is at https://github.com/nomadec/kitchen/issues/7.", "--json"],
    ["update", "kitchen-29", "--parent", "kitchen-20", "--add-label", "phase:approve-spec", "--assignee", "sona", "--json"],
  ]);
  assert.equal(k.out.join(""), "Laid pass approve-spec as kitchen-29 for sona, blocking kitchen-22\n");
});

test("lay pass: a pass Kitchen lays itself carries a title instead of a pass phase, blocks the order when nothing else, and takes its brief from stdin", async (t) => {
  const k = turn(t, [
    order(),
    { command: "bd", args: [...TURN, "gate", "create"], stdout: JSON.stringify({ id: "kitchen-30", title: "no station for pr", status: "open", issue_type: "gate", await_type: "human" }) },
    { command: "bd", args: [...TURN, "update", "kitchen-30"], stdout: "[]" },
  ], "sona/oven", "pr needs model claude-opus-5 and nomadec/kitchen checked out; sona/grill lacks model claude-opus-5\n");

  const code = await k.run("pass", "kitchen-20", "--title", "no station for pr", "--brief", "-");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.bd().slice(1), [
    ["gate", "create", "--type", "human", "--blocks", "kitchen-20", "--title", "no station for pr", "--reason", "pr needs model claude-opus-5 and nomadec/kitchen checked out; sona/grill lacks model claude-opus-5", "--json"],
    ["update", "kitchen-30", "--parent", "kitchen-20", "--assignee", "sona", "--json"],
  ]);
  assert.equal(k.out.join(""), "Laid pass no station for pr as kitchen-30 for sona, blocking kitchen-20\n");
});

test("lay pass: a slug that is a worked phase, not a pass phase, is refused before any write", async (t) => {
  const k = turn(t, [order(), phases(UMKA)]);
  assert.equal(await k.run("pass", "kitchen-20", "pr", "--blocks", "kitchen-22", "--brief", "x"), 2);
  assert.equal(k.err.join(""), "lay: pr is not a pass phase (skill: human): lay it with lay phase\n");
  assert.equal(k.writes().length, 0);
});

test("lay dep: each blocker becomes a bd dep add", async (t) => {
  const k = turn(t, [{ command: "bd", args: [...TURN, "dep", "add", "kitchen-31"] }]);
  assert.equal(await k.run("dep", "kitchen-31", "kitchen-22", "kitchen-25"), 0);
  assert.deepEqual(k.bd(), [["dep", "add", "kitchen-31", "kitchen-22"], ["dep", "add", "kitchen-31", "kitchen-25"]]);
  assert.equal(k.out.join(""), "kitchen-31 is blocked by kitchen-22, kitchen-25\n");
});

test("lay assign: the station label is swapped, the assignee set and the reason noted, after the same model and repository check", async (t) => {
  const k = turn(t, [
    { command: "bd", args: [...TURN, "show", "kitchen-22"], stdout: JSON.stringify([{ ...child("kitchen-22", "pr", "open"), description: PHASE("pr") }]) },
    order(), stations(OVEN, station("kitchen-11", "grill", ["claude-opus-5"], ["nomadec/kitchen", "sona-is/sona"])),
    { command: "bd", args: [...TURN, "update", "kitchen-22"], stdout: "[]" },
  ]);

  const code = await k.run("assign", "kitchen-22", "--station", "sona/grill", "--why", "grill has gh signed in");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.bd().at(-1), ["update", "kitchen-22", "--append-notes", "assigned: grill has gh signed in", "--add-label", "station:sona/grill", "--remove-label", "station:sona/oven", "--assignee", "sona/grill", "--json"]);
  assert.equal(k.out.join(""), "Assigned kitchen-22 to sona/grill\n");

  const j = turn(t, [
    { command: "bd", args: [...TURN, "show", "kitchen-22"], stdout: JSON.stringify([{ ...child("kitchen-22", "pr", "open"), description: PHASE("pr") }]) },
    order(), stations(OVEN, station("kitchen-11", "grill", ["claude-sonnet-5"], ["nomadec/kitchen"])),
  ]);
  assert.equal(await j.run("assign", "kitchen-22", "--station", "sona/grill", "--why", "x"), 2);
  assert.equal(j.err.join(""), "lay: no station for pr at sona/grill: it lacks model claude-opus-5\n");
  assert.equal(j.writes().length, 0);
});

test("lay close: a phase closes with the artifact as its reason; a pass is refused, since the driver never closes one", async (t) => {
  const k = turn(t, [
    { command: "bd", args: [...TURN, "show", "kitchen-21"], stdout: JSON.stringify([child("kitchen-21", "implement", "in_progress")]) },
    { command: "bd", args: [...TURN, "close", "kitchen-21"], stdout: "[]" },
  ]);
  assert.equal(await k.run("close", "kitchen-21", "--reason", "https://github.com/nomadec/kitchen/pull/9"), 0, k.err.join(""));
  assert.deepEqual(k.bd().at(-1), ["close", "kitchen-21", "--reason", "https://github.com/nomadec/kitchen/pull/9", "--json"]);
  assert.equal(k.out.join(""), "Closed kitchen-21: https://github.com/nomadec/kitchen/pull/9\n");

  const j = turn(t, [
    { command: "bd", args: [...TURN, "show", "kitchen-29"], stdout: JSON.stringify([{ id: "kitchen-29", title: "approve spec", status: "open", issue_type: "gate", await_type: "human" }]) },
  ]);
  assert.equal(await j.run("close", "kitchen-29", "--reason", "yes"), 2);
  assert.equal(j.writes().length, 0);
  assert.equal(j.err.join(""), "lay: kitchen-29 is a pass: a pass closes only under a person's name, through kitchen pass or the UI, never through the turn driver\n");
});

test("lay reopen, label and note: the reconcile writes, each one bd update", async (t) => {
  const k = turn(t, [
    { command: "bd", args: [...TURN, "update", "kitchen-19", "--status", "open"], stdout: "[]" },
    { command: "bd", args: [...TURN, "update", "kitchen-29", "--add-label", "applied"], stdout: "[]" },
    order(),
    { command: "bd", args: [...TURN, "update", "kitchen-20", "--notes"], stdout: "[]" },
  ]);
  assert.equal(await k.run("reopen", "kitchen-19"), 0, k.err.join(""));
  assert.equal(await k.run("label", "kitchen-29", "applied"), 0, k.err.join(""));
  assert.equal(await k.run("note", "kitchen-20", "class", "spec"), 0, k.err.join(""));
  assert.deepEqual(k.bd(), [
    ["update", "kitchen-19", "--status", "open", "--json"],
    ["update", "kitchen-29", "--add-label", "applied", "--json"],
    ["show", "kitchen-20", "--json"],
    ["update", "kitchen-20", "--notes", "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: spec", "--json"],
  ]);
  assert.equal(k.out.join(""), "Reopened kitchen-19\nLabelled kitchen-29 applied\nkitchen-20 class: spec\n");
});

test("lay runs only in a turn: a bare human actor, the expeditor, or no actor at all is refused before any call", async (t) => {
  for (const actor of ["sona", "sona/expeditor", null]) {
    const k = turn(t, [], actor);
    assert.equal(await k.run("reopen", "kitchen-19"), 2);
    assert.equal(k.runner.calls.length, 0);
    assert.equal(k.err.join(""), `lay: BEADS_ACTOR is ${actor ?? "unset"}, not a station: lay runs inside a turn, writing as <owner>/<station>\n`);
  }
});

test("lay: an unknown subcommand or a missing argument prints the usage and fails before any call", async (t) => {
  const k = turn(t, []);
  assert.equal(await k.run("bake", "kitchen-20"), 1);
  assert.match(k.err.join(""), /^lay: unknown subcommand bake\n\nUsage: lay <subcommand>/);
  assert.equal(await k.run("phase", "kitchen-20"), 1);
  assert.match(k.err.join(""), /lay phase <order> <slug> \[--station <title>\] --why <reason>/);
  assert.equal(await k.run("pass", "kitchen-20", "--blocks", "kitchen-22"), 1);
  assert.match(k.err.join(""), /--brief <text>/);
  assert.equal(k.runner.calls.length, 0);
});
