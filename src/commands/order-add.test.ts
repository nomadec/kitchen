// kitchen order add, exercised through the commands it issues: the gh read of an issue, the bd
// duplicate checks, the order bead, and the entry phase laid and assigned mechanically (or the
// pass that names the gap).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

const ISSUE = "https://github.com/nomadec/kitchen/issues/7";

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], sessionEnv: Record<string, string> = {}) {
  const host = initialisedHost(t, table, { sessionEnv });
  const run = (...argv: string[]) => main(["order", "add", ...argv], host.deps);
  /** The argv of every bd call, after `bd --actor sona`. */
  const bd = () => host.runner.calls.filter((c) => c.argv[0] === "bd").map((c) => c.argv.slice(3));
  return { ...host, run, bd };
}

/** The registered Umka phases a test needs: implement is the entry for a ticket, reproduce for a bug, grill for an idea. */
const PHASE = (slug: string, entry: string, model = "claude-opus-5") =>
  `---\nphase: ${slug}\nskill: umka:${slug}\nfrom: []\nto: []\nartifact: a PR\nmodel: ${model}\nentry: [${entry}]\nbudget:\n  usd: 5\n  effort: high\n---\n# ${slug}\n`;

const REGISTERED = (...phases: { slug: string; entry: string; model?: string; rev?: string }[]) =>
  JSON.stringify(
    phases.map((p, i) => ({
      id: `kitchen-${i + 1}`, title: `umka/${p.slug}`, status: "open", issue_type: "phase",
      labels: [`rev:${p.rev ?? "a1b2c3d"}`, ...(p.rev === "old" ? ["superseded"] : [])],
      description: PHASE(p.slug, p.entry, p.model),
    })),
  );

const station = (id: string, name: string, models: string[], repos: string[], attended = false) => ({
  id, title: `sona/${name}`, status: "open", issue_type: "station",
  labels: ["owner:sona", "host:sona-laptop", "cap:2", ...(attended ? ["attended"] : [])],
  notes: `offers: ${repos.join(" and ")} checked out\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models, auth: "subscription", plugins: [], skills: [],
    repositories: repos.map((slug) => ({ slug, path: `/home/sona/src/${slug.split("/")[1]}` })),
    worktrees: "per-order", cap: 2, budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [],
  })}\n\`\`\``,
});

const issueView = (labels: string[], body = "Logging in with a stale cookie shows a blank page.\n"): ScriptedAnswer => ({
  command: "gh",
  args: ["issue", "view", ISSUE],
  stdout: JSON.stringify({ title: "Stale cookie shows a blank page", body, url: ISSUE, labels: labels.map((name) => ({ name })) }),
});

const noDuplicate: ScriptedAnswer[] = [
  { command: "bd", args: ["--actor", "sona", "list", "--type", "epic", "--label", "loop", "--external-ref"], stdout: "[]" },
  { command: "bd", args: ["--actor", "sona", "list", "--type", "epic", "--label", "loop", "--external-contains"], stdout: "[]" },
];

const phases = (json: string): ScriptedAnswer => ({ command: "bd", args: ["--actor", "sona", "list", "--type", "phase"], stdout: json });
const stations = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: ["--actor", "sona", "list", "--type", "station", "--label", "owner:sona"], stdout: JSON.stringify(rows) });
const running = (name: string, count: number): ScriptedAnswer => ({
  command: "bd", args: ["--actor", "sona", "list", "--assignee", `sona/${name}`, "--status", "in_progress"],
  stdout: JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: `kitchen-9${i}`, title: "a turn", status: "in_progress", issue_type: "task" }))),
});
const created = (id: string, title: string, type: string, ...prefix: string[]): ScriptedAnswer => ({
  command: "bd", args: ["--actor", "sona", "create", ...prefix],
  stdout: JSON.stringify({ id, title, status: "open", issue_type: type }),
});

const ORDER = created("kitchen-20", "Stale cookie shows a blank page", "epic", "Stale cookie shows a blank page", "--type", "epic");
const UMKA = phases(REGISTERED({ slug: "implement", entry: "ticket" }, { slug: "reproduce", entry: "bug" }, { slug: "grill", entry: "idea" }, { slug: "sort", entry: "unsorted" }));

test("an issue URL produces the order bead with class, pinned revision, repos and external reference, and the entry phase assigned to the one qualifying station with the entry: mechanical note", async (t) => {
  const k = kitchen(t, [
    issueView(["bug"]),
    ...noDuplicate,
    UMKA,
    stations(station("kitchen-10", "grill", ["claude-opus-5", "claude-sonnet-5"], ["nomadec/kitchen", "sona-is/sona"])),
    running("grill", 0),
    ORDER,
    created("kitchen-21", "reproduce: Stale cookie shows a blank page", "task", "reproduce: Stale cookie shows a blank page"),
  ]);

  const code = await k.run(ISSUE, "--recipe", "umka");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.runner.calls[0]?.argv, ["gh", "issue", "view", ISSUE, "--json", "title,body,url,labels"]);
  assert.deepEqual(k.bd(), [
    ["list", "--type", "epic", "--label", "loop", "--external-ref", ISSUE, "--limit", "0", "--json"],
    ["list", "--type", "epic", "--label", "loop", "--external-contains", "nomadec/kitchen/issues/7", "--limit", "0", "--json"],
    ["list", "--type", "phase", "--limit", "0", "--json"],
    ["list", "--type", "station", "--label", "owner:sona", "--limit", "0", "--json"],
    ["list", "--assignee", "sona/grill", "--status", "in_progress", "--limit", "0", "--json"],
    [
      "create", "Stale cookie shows a blank page",
      "--type", "epic",
      "--labels", "loop",
      "--notes", "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: bug",
      "--description", "Logging in with a stale cookie shows a blank page.\n",
      "--external-ref", ISSUE,
      "--json",
    ],
    [
      "create", "reproduce: Stale cookie shows a blank page",
      "--type", "task",
      "--parent", "kitchen-20", "--no-inherit-labels",
      "--labels", "phase:reproduce,station:sona/grill",
      "--notes", "model: claude-opus-5\nentry: mechanical",
      "--description", PHASE("reproduce", "bug"),
      "--assignee", "sona/grill",
      "--json",
    ],
  ]);
  for (const call of k.runner.calls.filter((c) => c.argv[0] === "bd")) assert.deepEqual({ cwd: call.cwd, env: call.env }, k.connection);
  assert.match(k.out.join(""), /Added order kitchen-20 \(bug, umka rev:a1b2c3d\) from https:\/\/github\.com\/nomadec\/kitchen\/issues\/7\n/);
  assert.match(k.out.join(""), /Laid reproduce as kitchen-21 at sona\/grill \(entry: mechanical\)\n/);
});

const EXISTING = (how: "--external-ref" | "--external-contains"): ScriptedAnswer => ({
  command: "bd",
  args: ["--actor", "sona", "list", "--type", "epic", "--label", "loop", how],
  stdout: JSON.stringify([{
    id: "kitchen-15", title: "Stale cookie shows a blank page", status: "in_progress", issue_type: "epic",
    external_ref: ISSUE, labels: ["loop"], notes: "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: bug",
  }]),
});

test("a source whose external reference is an order already produces no second order: the existing one is printed and the command stops", async (t) => {
  const k = kitchen(t, [issueView(["bug"]), EXISTING("--external-ref")]);

  const code = await k.run(ISSUE, "--recipe", "umka");

  assert.notEqual(code, 0);
  assert.deepEqual(k.bd(), [["list", "--type", "epic", "--label", "loop", "--external-ref", ISSUE, "--limit", "0", "--json"]]);
  assert.equal(k.out.join(""), `An order for ${ISSUE} exists already:\n  kitchen-15 Stale cookie shows a blank page (in_progress, bug, umka rev:a1b2c3d) from ${ISSUE}\n`);
});

test("a source matched by external-reference substring (the same issue under another URL form) is a duplicate too", async (t) => {
  const k = kitchen(t, [
    issueView(["bug"]),
    { command: "bd", args: ["--actor", "sona", "list", "--type", "epic", "--label", "loop", "--external-ref"], stdout: "[]" },
    EXISTING("--external-contains"),
  ]);

  const code = await k.run(ISSUE, "--recipe", "umka");

  assert.notEqual(code, 0);
  assert.equal(k.bd().length, 2);
  assert.deepEqual(k.bd()[1], ["list", "--type", "epic", "--label", "loop", "--external-contains", "nomadec/kitchen/issues/7", "--limit", "0", "--json"]);
  assert.match(k.out.join(""), /exists already:\n  kitchen-15 /);
  assert.ok(!k.bd().some((argv) => argv[0] === "create"), "no order was created");
});

const GRILL = stations(station("kitchen-10", "grill", ["claude-opus-5", "claude-sonnet-5"], ["nomadec/kitchen", "sona-is/sona"]));

/** The class an issue enters with, read from the `class:` note of the order create. */
async function classOf(t: { after(fn: () => void): void }, labels: string[], ...argv: string[]): Promise<{ cls: string; slug: string }> {
  const k = kitchen(t, [
    issueView(labels), ...noDuplicate, UMKA, GRILL, running("grill", 0),
    { command: "bd", args: ["--actor", "sona", "create", "Stale cookie shows a blank page", "--type", "epic"], stdout: '{"id":"kitchen-20","title":"Stale cookie shows a blank page","status":"open","issue_type":"epic"}' },
    { command: "bd", args: ["--actor", "sona", "create"], stdout: '{"id":"kitchen-21","title":"x","status":"open","issue_type":"task"}' },
  ]);
  assert.equal(await k.run(ISSUE, "--recipe", "umka", ...argv), 0, k.err.join(""));
  const order = k.bd().find((a) => a[0] === "create" && a[3] === "epic")!;
  const phase = k.bd().find((a) => a[0] === "create" && a[3] === "task")!;
  return { cls: /class: (\w+)/.exec(order[order.indexOf("--notes") + 1] ?? "")?.[1] ?? "", slug: phase[1]?.split(":")[0] ?? "" };
}

test("class is inferred from an issue's labels: bug is a bug, ready-for-agent a spec, anything else a ticket; --class overrides", async (t) => {
  assert.deepEqual(await classOf(t, ["bug", "ready-for-agent"]), { cls: "bug", slug: "reproduce" });
  assert.deepEqual(await classOf(t, ["enhancement"]), { cls: "ticket", slug: "implement" });
  assert.deepEqual(await classOf(t, ["enhancement"], "--class", "idea"), { cls: "idea", slug: "grill" });
  assert.deepEqual(await classOf(t, ["bug"], "--class", "unsorted"), { cls: "unsorted", slug: "sort" });
});

test("a ready-for-agent issue is a spec, which this recipe has no entry phase for: refused before any bead is created", async (t) => {
  const k = kitchen(t, [issueView(["ready-for-agent"]), ...noDuplicate, UMKA]);
  assert.notEqual(await k.run(ISSUE, "--recipe", "umka"), 0);
  assert.match(k.err.join(""), /umka rev:a1b2c3d has no entry phase for class spec/);
  assert.ok(!k.bd().some((argv) => argv[0] === "create"));
});

test("a file is an idea: its first heading is the title, its text the description, file:<path> the external reference and the stem the substring; --repo names the repositories", async (t) => {
  const k = kitchen(t, [
    ...noDuplicate, UMKA, GRILL, running("grill", 0),
    created("kitchen-22", "Training venues", "epic", "Training venues", "--type", "epic"),
    created("kitchen-23", "grill: Training venues", "task", "grill: Training venues"),
  ]);
  const file = path.join(k.home, "training-venues.md");
  fs.writeFileSync(file, "# Training venues\n\nLet a venue be booked from the course page.\n");

  const code = await k.run(file, "--recipe", "umka", "--repo", "sona-is/sona", "--repo", "nomadec/kitchen");

  assert.equal(code, 0, k.err.join(""));
  assert.ok(!k.runner.calls.some((c) => c.argv[0] === "gh"), "no gh call for a file");
  assert.deepEqual(k.bd()[0]?.slice(5, 7), ["--external-ref", `file:${file}`]);
  assert.deepEqual(k.bd()[1]?.slice(5, 7), ["--external-contains", "training-venues"]);
  const order = k.bd().find((a) => a[0] === "create" && a[3] === "epic")!;
  assert.equal(order[order.indexOf("--notes") + 1], "repos: sona-is/sona, nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: idea");
  assert.equal(order[order.indexOf("--description") + 1], "# Training venues\n\nLet a venue be booked from the course page.\n");
  assert.equal(order[order.indexOf("--external-ref") + 1], `file:${file}`);
  const phase = k.bd().find((a) => a[0] === "create" && a[3] === "task")!;
  assert.equal(phase[phase.indexOf("--labels") + 1], "phase:grill,station:sona/grill");
});

test("free text is an idea: the sentence is the title, the description and the reference, and the order names no repository", async (t) => {
  const k = kitchen(t, [
    ...noDuplicate, UMKA, GRILL, running("grill", 0),
    created("kitchen-24", "Let a venue be booked", "epic", "Let a venue be booked", "--type", "epic"),
    created("kitchen-25", "grill: Let a venue be booked", "task", "grill: Let a venue be booked"),
  ]);

  const code = await k.run("Let a venue be booked", "--recipe", "umka");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.bd()[0]?.slice(5, 7), ["--external-ref", "text:Let a venue be booked"]);
  assert.deepEqual(k.bd()[1]?.slice(5, 7), ["--external-contains", "Let a venue be booked"]);
  const order = k.bd().find((a) => a[0] === "create" && a[3] === "epic")!;
  assert.equal(order[order.indexOf("--notes") + 1], "repos: \nrecipe: umka rev:a1b2c3d\nclass: idea");
  assert.equal(order[order.indexOf("--description") + 1], "Let a venue be booked");
});

test("no qualifying station: the order is created, the entry phase is laid unassigned with no station: label, and a pass titled no station for <phase>, the owner's and the order's child, blocks the phase and names the gap", async (t) => {
  const k = kitchen(t, [
    issueView(["bug"]), ...noDuplicate, UMKA,
    stations(
      station("kitchen-10", "grill", ["claude-sonnet-5"], ["nomadec/kitchen"]),
      station("kitchen-11", "pantry", ["claude-opus-5"], ["sona-is/sona"]),
    ),
    ORDER,
    created("kitchen-21", "reproduce: Stale cookie shows a blank page", "task", "reproduce: Stale cookie shows a blank page"),
    { command: "bd", args: ["--actor", "sona", "gate", "create"], stdout: '{"id":"kitchen-30","title":"no station for reproduce","status":"open","issue_type":"gate","await_type":"human"}' },
    { command: "bd", args: ["--actor", "sona", "update", "kitchen-30"], stdout: "{}" },
  ]);

  const code = await k.run(ISSUE, "--recipe", "umka");

  assert.equal(code, 0, k.err.join(""));
  const gap = "reproduce needs model claude-opus-5 and nomadec/kitchen checked out; sona/grill lacks model claude-opus-5; sona/pantry lacks nomadec/kitchen";
  assert.deepEqual(k.bd().slice(4), [
    ["create", "Stale cookie shows a blank page", "--type", "epic", "--labels", "loop", "--notes", "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: bug", "--description", "Logging in with a stale cookie shows a blank page.\n", "--external-ref", ISSUE, "--json"],
    [
      "create", "reproduce: Stale cookie shows a blank page",
      "--type", "task",
      "--parent", "kitchen-20", "--no-inherit-labels",
      "--labels", "phase:reproduce",
      "--notes", "model: claude-opus-5\nentry: mechanical",
      "--description", PHASE("reproduce", "bug"),
      "--json",
    ],
    ["gate", "create", "--type", "human", "--blocks", "kitchen-21", "--title", "no station for reproduce", "--reason", gap, "--json"],
    ["update", "kitchen-30", "--parent", "kitchen-20", "--assignee", "sona", "--json"],
  ]);
  assert.match(k.out.join(""), /No station for reproduce: laid kitchen-21 unassigned behind pass kitchen-30 \(reproduce needs model claude-opus-5/);
});

test("among three qualifying stations the unattended ones come first, then the fewest running turns", async (t) => {
  const three = stations(
    station("kitchen-10", "desk", ["claude-opus-5"], ["nomadec/kitchen"], true),
    station("kitchen-11", "oven", ["claude-opus-5"], ["nomadec/kitchen"]),
    station("kitchen-12", "pantry", ["claude-opus-5"], ["nomadec/kitchen"]),
  );
  const k = kitchen(t, [
    issueView(["bug"]), ...noDuplicate, UMKA, three,
    running("desk", 0), running("oven", 2), running("pantry", 1),
    ORDER,
    created("kitchen-21", "reproduce: Stale cookie shows a blank page", "task", "reproduce: Stale cookie shows a blank page"),
  ]);

  assert.equal(await k.run(ISSUE, "--recipe", "umka"), 0, k.err.join(""));

  const phase = k.bd().find((a) => a[0] === "create" && a[3] === "task")!;
  assert.equal(phase[phase.indexOf("--assignee") + 1], "sona/pantry");
  assert.equal(phase[phase.indexOf("--labels") + 1], "phase:reproduce,station:sona/pantry");
  assert.match(k.out.join(""), /at sona\/pantry/);
});

test("a superseded revision is not pinned: the latest revision's entry phase is laid", async (t) => {
  const k = kitchen(t, [
    issueView(["bug"]), ...noDuplicate,
    phases(REGISTERED({ slug: "reproduce", entry: "bug", rev: "old" }, { slug: "reproduce", entry: "bug", rev: "f00ba12" })),
    GRILL, running("grill", 0), ORDER,
    created("kitchen-21", "reproduce: Stale cookie shows a blank page", "task", "reproduce: Stale cookie shows a blank page"),
  ]);
  assert.equal(await k.run(ISSUE, "--recipe", "umka"), 0, k.err.join(""));
  const order = k.bd().find((a) => a[0] === "create" && a[3] === "epic")!;
  assert.match(order[order.indexOf("--notes") + 1] ?? "", /recipe: umka rev:f00ba12/);
});

test("a recipe whose beads not superseded span two revisions is refused: a registration that did not finish", async (t) => {
  const k = kitchen(t, [issueView(["bug"]), ...noDuplicate, phases(REGISTERED({ slug: "reproduce", entry: "bug", rev: "a1b2c3d" }, { slug: "implement", entry: "ticket", rev: "f00ba12" }))]);
  assert.notEqual(await k.run(ISSUE, "--recipe", "umka"), 0);
  assert.match(k.err.at(-1) ?? "", /recipe umka has beads of more than one revision not superseded \(rev:a1b2c3d, rev:f00ba12\): register it again/);
  assert.ok(!k.bd().some((argv) => argv[0] === "create"));
});

test("a missing recipe, an unknown class, an unregistered recipe and a host without kitchen init are each refused naming the gap", async (t) => {
  const k = kitchen(t, [issueView(["bug"]), ...noDuplicate, phases("[]")]);
  assert.notEqual(await k.run(ISSUE), 0);
  assert.match(k.err.at(-1) ?? "", /--recipe <name> is required/);
  assert.notEqual(await k.run("--recipe", "umka"), 0);
  assert.match(k.err.at(-1) ?? "", /a source is required/);
  assert.notEqual(await k.run(ISSUE, "--recipe", "umka", "--class", "feature"), 0);
  assert.match(k.err.at(-1) ?? "", /--class must be one of unsorted, question, idea, proposal, spec, ticket, bug, got feature/);
  assert.equal(k.runner.calls.length, 0);
  assert.notEqual(await k.run(ISSUE, "--recipe", "umka"), 0);
  assert.match(k.err.at(-1) ?? "", /recipe umka is not registered: run kitchen recipe add first/);
  fs.rmSync(k.configFile);
  assert.notEqual(await k.run(ISSUE, "--recipe", "umka"), 0);
  assert.match(k.err.at(-1) ?? "", /run kitchen init first/);
});
