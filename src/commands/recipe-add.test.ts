// kitchen recipe add, exercised through the bd calls it issues: a plugin directory in, the phase
// beads of a revision out, and the bundle refused before any create when the lint fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../cli.ts";
import type { CliDeps } from "../cli.ts";
import { writeHostConfig } from "../config.ts";
import { fakeClock, fakeRunner } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

interface Scope {
  after(fn: () => void): void;
}

function kitchen(t: Scope, table: readonly ScriptedAnswer[], sessionEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-recipe-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...sessionEnv };
  writeHostConfig(env, {
    server: { host: "rbn3", port: 3307, user: "sona", database: "kitchen" },
    credential: "/home/sona/.config/beads/credentials",
    owner: "sona",
    host: "sona-laptop",
  });
  const out: string[] = [];
  const err: string[] = [];
  const runner = fakeRunner(table);
  const deps: CliDeps = {
    runner, clock: fakeClock(), env, hostname: "sona-laptop",
    program: { platform: "linux", argv: ["/usr/bin/node", "/opt/kitchen/dist/bin/kitchen.js"], pluginDir: "/opt/kitchen/plugin" },
    stdout: (s) => out.push(s), stderr: (s) => err.push(s),
  };
  return { home, run: (...argv: string[]) => main(argv, deps), runner, out, err };
}

/** Writes a plugin directory: `.claude-plugin/plugin.json` naming the recipe and one phase file per slug. */
function plugin(home: string, name: string, phases: Record<string, string>): string {
  const dir = path.join(home, "plugins", name);
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "phases"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "0.1.0" }));
  for (const [slug, text] of Object.entries(phases)) fs.writeFileSync(path.join(dir, "phases", `${slug}.md`), text);
  return dir;
}

const SORT = `---
phase: sort
skill: umka:sort
model: claude-sonnet-5
entry: [unsorted]
from: []
to:
  - phase: grill
    when: the class is idea
artifact: the order has a class
budget:
  usd: 2
  effort: medium
---
# sort

**Run:** read the order and give it a class.
`;

const GRILL = `---
phase: grill
skill: mattpocock-skills:grill
model: claude-opus-5
needs: a human present in the session
rounds: 3
from: [sort]
to:
  - phase: approve-proposal
artifact: the proposal on the tracker
budget:
  usd: 8
  effort: high
---
# grill

**Run:** interview the human until the proposal stands.
`;

const APPROVE_PROPOSAL = `---
phase: approve-proposal
skill: human
from: [grill]
to: []
artifact: the pass is closed
ask: the proposal in five lines, then each ADR and glossary term recorded, one line each
skip when: the proposal changes nothing a human has to see
---
# approve proposal

The human approves the proposal before it is specified.
`;

const UMKA = { sort: SORT, grill: GRILL, "approve-proposal": APPROVE_PROPOSAL };

const NO_PHASES: ScriptedAnswer = { command: "bd", args: ["--actor", "sona", "list"], stdout: "[]" };
const CREATED: ScriptedAnswer = { command: "bd", args: ["--actor", "sona", "create"], stdout: '{"id":"kitchen-7","issue_type":"phase","status":"open"}' };
const UPDATED: ScriptedAnswer = { command: "bd", args: ["--actor", "sona", "update"], stdout: "[]" };

const CONNECTION = (home: string) => ({
  cwd: path.join(home, ".config", "kitchen", "space"),
  env: { BEADS_CREDENTIALS_FILE: "/home/sona/.config/beads/credentials" },
});

/** The `rev:` label of a create call. */
const revisionOf = (argv: readonly string[]) => argv[argv.indexOf("--labels") + 1];

test("a plugin directory with a valid bundle produces one phase bead per file, titled <recipe>/<slug>, labelled rev:<revision>, the file as description", async (t) => {
  const k = kitchen(t, [NO_PHASES, CREATED]);
  const dir = plugin(k.home, "umka", UMKA);

  const code = await k.run("recipe", "add", dir);

  assert.equal(code, 0, k.err.join(""));
  const calls = k.runner.calls;
  assert.deepEqual(calls[0], { argv: ["bd", "--actor", "sona", "list", "--type", "phase", "--limit", "0", "--json"], ...CONNECTION(k.home) });
  const creates = calls.slice(1);
  const revision = revisionOf(creates[0]?.argv ?? []);
  assert.match(revision ?? "", /^rev:[0-9a-f]{7}$/, "the revision is a short content hash");
  assert.deepEqual(
    creates.map((c) => c.argv),
    [
      ["bd", "--actor", "sona", "create", "umka/approve-proposal", "--type", "phase", "--labels", revision, "--description", APPROVE_PROPOSAL, "--json"],
      ["bd", "--actor", "sona", "create", "umka/grill", "--type", "phase", "--labels", revision, "--description", GRILL, "--json"],
      ["bd", "--actor", "sona", "create", "umka/sort", "--type", "phase", "--labels", revision, "--description", SORT, "--json"],
    ],
  );
  assert.ok(creates.every((c) => c.cwd === CONNECTION(k.home).cwd), "every write runs over the space connection");
  assert.match(k.out.join(""), new RegExp(`Registered umka ${revision} with 3 phases`));
});

const PHASE_BEAD = (id: string, title: string, rev: string, description: string, extra: string[] = []) =>
  ({ id, title, status: "open", issue_type: "phase", labels: [`rev:${rev}`, ...extra], description });

test("a second registration of a changed bundle creates a new revision and labels the previous revision's beads superseded; laid phases are untouched", async (t) => {
  const first = kitchen(t, [NO_PHASES, CREATED]);
  await first.run("recipe", "add", plugin(first.home, "umka", UMKA));
  const previous = revisionOf(first.runner.calls[1]?.argv ?? [])?.slice("rev:".length) ?? "";

  const registered = [
    PHASE_BEAD("kitchen-1", "umka/approve-proposal", previous, APPROVE_PROPOSAL),
    PHASE_BEAD("kitchen-2", "umka/grill", previous, GRILL),
    PHASE_BEAD("kitchen-3", "umka/sort", previous, SORT),
    PHASE_BEAD("kitchen-0", "umka/sort", "0000000", SORT, ["superseded"]),
  ];
  const k = kitchen(t, [{ ...NO_PHASES, stdout: JSON.stringify(registered) }, CREATED, UPDATED]);
  const changed = { ...UMKA, grill: GRILL.replace("rounds: 3", "rounds: 4") };

  const code = await k.run("recipe", "add", plugin(k.home, "umka", changed));

  assert.equal(code, 0, k.err.join(""));
  const argvs = k.runner.calls.map((c) => c.argv);
  const revision = revisionOf(argvs[1] ?? []) ?? "";
  assert.match(revision, /^rev:[0-9a-f]{7}$/);
  assert.notEqual(revision, `rev:${previous}`, "a changed bundle is a new revision");
  assert.deepEqual(argvs.slice(1), [
    ["bd", "--actor", "sona", "create", "umka/approve-proposal", "--type", "phase", "--labels", revision, "--description", APPROVE_PROPOSAL, "--json"],
    ["bd", "--actor", "sona", "create", "umka/grill", "--type", "phase", "--labels", revision, "--description", changed.grill, "--json"],
    ["bd", "--actor", "sona", "create", "umka/sort", "--type", "phase", "--labels", revision, "--description", SORT, "--json"],
    ["bd", "--actor", "sona", "update", "kitchen-1", "--add-label", "superseded", "--json"],
    ["bd", "--actor", "sona", "update", "kitchen-2", "--add-label", "superseded", "--json"],
    ["bd", "--actor", "sona", "update", "kitchen-3", "--add-label", "superseded", "--json"],
  ]);
  assert.match(k.out.join(""), /3 beads of the previous revision labelled superseded/);
});

test("registering the bundle already at the latest revision issues no write", async (t) => {
  const first = kitchen(t, [NO_PHASES, CREATED]);
  await first.run("recipe", "add", plugin(first.home, "umka", UMKA));
  const current = revisionOf(first.runner.calls[1]?.argv ?? [])?.slice("rev:".length) ?? "";
  const registered = [
    PHASE_BEAD("kitchen-1", "umka/approve-proposal", current, APPROVE_PROPOSAL),
    PHASE_BEAD("kitchen-2", "umka/grill", current, GRILL),
    PHASE_BEAD("kitchen-3", "umka/sort", current, SORT),
  ];
  const k = kitchen(t, [{ ...NO_PHASES, stdout: JSON.stringify(registered) }]);

  assert.equal(await k.run("recipe", "add", plugin(k.home, "umka", UMKA)), 0, k.err.join(""));
  assert.equal(k.runner.calls.length, 1, "only the list was issued");
  assert.match(k.out.join(""), new RegExp(`umka rev:${current} is already the latest revision`));
});

/** Runs a registration expected to be refused: the message and that no bd write was issued. */
async function refused(t: Scope, phases: Record<string, string>, ...expected: RegExp[]) {
  const k = kitchen(t, [NO_PHASES]);
  const code = await k.run("recipe", "add", plugin(k.home, "umka", phases));
  assert.notEqual(code, 0, "the bundle is refused");
  const message = k.err.join("");
  assert.match(message, /refused umka/);
  for (const pattern of expected) assert.match(message, pattern);
  assert.deepEqual(k.runner.calls.map((c) => c.argv[3]), ["list"], "no bd write was issued");
  return message;
}

test("a dangling edge is refused, naming the phase and the rule", async (t) => {
  await refused(t, { ...UMKA, grill: GRILL.replace("phase: approve-proposal", "phase: approve-design") },
    /umka\/grill: to: "approve-design" is not a registered phase/);
  await refused(t, { ...UMKA, sort: SORT.replace("from: []", "from: [source]") },
    /umka\/sort: from: "source" is not a registered phase.*an entry phase lists the classes it starts under entry/);
});

test("an asymmetric edge is refused on both ends", async (t) => {
  const message = await refused(t, { ...UMKA, "approve-proposal": APPROVE_PROPOSAL.replace("from: [grill]", "from: []") },
    /umka\/grill: to: target "approve-proposal" does not list grill in its from/);
  assert.doesNotMatch(message, /umka\/sort/);
  await refused(t, { ...UMKA, grill: GRILL.replace("from: [sort]", "from: [sort, approve-proposal]") },
    /umka\/grill: from: "approve-proposal" does not list grill in its to/);
});

test("a token-count or scalar budget is refused; budget is an object with usd and effort", async (t) => {
  await refused(t, { ...UMKA, grill: GRILL.replace(/budget:\n  usd: 8\n  effort: high\n/, "budget: 30k\n") },
    /umka\/grill: budget: "30k" is a token count or a bare number; budget is an object with usd \(a dollar cap\) and effort/);
  await refused(t, { ...UMKA, grill: GRILL.replace("usd: 8", "usd: 30k") },
    /umka\/grill: budget: usd "30k" is not a dollar amount above zero/);
  await refused(t, { ...UMKA, grill: GRILL.replace(/budget:\n  usd: 8\n  effort: high\n/, "") },
    /umka\/grill: budget: missing/);
});

test("two entry phases for one class are refused", async (t) => {
  await refused(t, { ...UMKA, grill: GRILL.replace("rounds: 3", "entry: [unsorted, idea]") },
    /umka\/grill: entry: class unsorted has more than one entry phase: grill, sort/,
    /umka\/sort: entry: class unsorted has more than one entry phase: grill, sort/);
});

test("an entry phase with needs is refused: intake assigns it mechanically", async (t) => {
  await refused(t, { ...UMKA, sort: SORT.replace("entry: [unsorted]", "entry: [unsorted]\nneeds: a human present") },
    /umka\/sort: needs: an entry phase has no needs/);
});

test("rounds and model must be well-formed, and the keys Umka dropped are refused by name", async (t) => {
  await refused(t, { ...UMKA, grill: GRILL.replace("rounds: 3", "rounds: three") }, /umka\/grill: rounds: "three" is not a positive whole number/);
  await refused(t, { ...UMKA, grill: GRILL.replace("model: claude-opus-5", "model: opus or sonnet") }, /umka\/grill: model: "opus or sonnet" is not one model name/);
  await refused(t, { ...UMKA, grill: GRILL.replace("rounds: 3", "mode: hitl") }, /umka\/grill: mode: unknown key \(gone in Kitchen/);
  await refused(t, { ...UMKA, grill: GRILL.replace("rounds: 3", "skip when: nothing changed") }, /umka\/grill: skip when: only a pass phase/);
  await refused(t, { ...UMKA, "approve-proposal": APPROVE_PROPOSAL.replace(/ask: .*\n/, "") }, /umka\/approve-proposal: ask: missing on a pass phase/);
});

test("a cycle is accepted", async (t) => {
  const k = kitchen(t, [NO_PHASES, CREATED]);
  const cyclic = {
    ...UMKA,
    grill: GRILL.replace("to:\n  - phase: approve-proposal", "to:\n  - phase: approve-proposal\n  - phase: sort\n    when: the idea needs sorting again"),
    sort: SORT.replace("from: []", "from: [grill]"),
  };
  assert.equal(await k.run("recipe", "add", plugin(k.home, "umka", cyclic)), 0, k.err.join(""));
  assert.equal(k.runner.calls.filter((c) => c.argv[3] === "create").length, 3);
});

test("an edge naming a phase of an already-registered recipe is accepted, by slug or as <recipe>/<slug>", async (t) => {
  const registered = [
    PHASE_BEAD("kitchen-1", "umka/approve-proposal", "a1b2c3d", APPROVE_PROPOSAL),
    PHASE_BEAD("kitchen-2", "umka/grill", "a1b2c3d", GRILL),
    PHASE_BEAD("kitchen-3", "umka/sort", "a1b2c3d", SORT),
  ];
  const REPRODUCE = `---
phase: reproduce
skill: bugs:reproduce
model: claude-sonnet-5
entry: [bug]
from: []
to:
  - phase: grill
    when: the failure is a design question
  - phase: umka/sort
    when: the failure is not a bug
artifact: the cause is named on the ticket
budget:
  usd: 4
  effort: medium
---
# reproduce
`;
  const k = kitchen(t, [{ ...NO_PHASES, stdout: JSON.stringify(registered) }, CREATED]);

  assert.equal(await k.run("recipe", "add", plugin(k.home, "bugs", { reproduce: REPRODUCE })), 0, k.err.join(""));
  const argvs = k.runner.calls.map((c) => c.argv);
  assert.equal(argvs.length, 2, "the list, then one create; umka's beads are not superseded");
  assert.equal(argvs[1]?.[4], "bugs/reproduce");

  const dangling = kitchen(t, [NO_PHASES]);
  assert.notEqual(await dangling.run("recipe", "add", plugin(dangling.home, "bugs", { reproduce: REPRODUCE })), 0);
  assert.match(dangling.err.join(""), /bugs\/reproduce: to: "grill" is not a registered phase/);
});

test("under a station actor the command is refused before any bd call", async (t) => {
  const k = kitchen(t, [], { BEADS_ACTOR: "sona/grill" });
  const code = await k.run("recipe", "add", plugin(k.home, "umka", UMKA));
  assert.notEqual(code, 0);
  assert.match(k.err.join(""), /sona\/grill may not register a recipe: registration is a human act/);
  assert.match(k.err.join(""), /cooperative rule/);
  assert.deepEqual(k.runner.calls, []);
});

test("one phase file, or one fetched from a URL, registers as a one-phase recipe named by --recipe", async (t) => {
  const SOLO = SORT.replace("to:\n  - phase: grill\n    when: the class is idea\n", "to: []\n");
  const k = kitchen(t, [NO_PHASES, CREATED]);
  const file = path.join(k.home, "sort.md");
  fs.writeFileSync(file, SOLO);

  assert.notEqual(await k.run("recipe", "add", file), 0);
  assert.match(k.err.join(""), /name its recipe with --recipe <name>/);
  assert.equal(await k.run("recipe", "add", file, "--recipe", "triage"), 0, k.err.join(""));
  assert.equal(k.runner.calls.at(-1)?.argv[4], "triage/sort");

  const url = "https://raw.githubusercontent.com/nomadec/marketplace/main/umka/phases/sort.md";
  const fetched = kitchen(t, [{ command: "curl", args: ["-fsSL", url], stdout: SOLO }, NO_PHASES, CREATED]);
  assert.equal(await fetched.run("recipe", "add", url, "--recipe", "triage"), 0, fetched.err.join(""));
  assert.deepEqual(fetched.runner.calls[0]?.argv, ["curl", "-fsSL", url]);
  const create = fetched.runner.calls.at(-1)?.argv ?? [];
  assert.equal(create[4], "triage/sort");
  assert.equal(create[create.indexOf("--description") + 1], SOLO);
});

test("without a host config the command says to run kitchen init first", async (t) => {
  const k = kitchen(t, []);
  fs.rmSync(path.join(k.home, ".config", "kitchen", "config.json"));
  assert.notEqual(await k.run("recipe", "add", plugin(k.home, "umka", UMKA)), 0);
  assert.match(k.err.join(""), /run kitchen init first/);
  assert.deepEqual(k.runner.calls, []);
});

test("an edge may name a phase of its own bundle as <recipe>/<slug>, and a recipe left with two unsuperseded revisions is still one recipe", async (t) => {
  const registered = [
    PHASE_BEAD("kitchen-2", "umka/grill", "a1b2c3d", GRILL),
    PHASE_BEAD("kitchen-5", "umka/grill", "e4f5a6b", GRILL.replace("rounds: 3", "rounds: 4")),
  ];
  const REPRODUCE = `---
phase: reproduce
skill: bugs:reproduce
model: claude-sonnet-5
entry: [bug]
from: [bugs/answer]
to:
  - phase: grill
  - phase: bugs/answer
artifact: the cause is named on the ticket
budget:
  usd: 4
  effort: medium
---
`;
  const ANSWER = `---
phase: answer
skill: bugs:answer
model: claude-sonnet-5
from: [reproduce]
to:
  - phase: bugs/reproduce
artifact: the answer on the ticket
budget:
  usd: 1
  effort: low
---
`;
  const k = kitchen(t, [{ ...NO_PHASES, stdout: JSON.stringify(registered) }, CREATED]);
  assert.equal(await k.run("recipe", "add", plugin(k.home, "bugs", { reproduce: REPRODUCE, answer: ANSWER })), 0, k.err.join(""));
  assert.equal(k.runner.calls.filter((c) => c.argv[3] === "create").length, 2);
});
