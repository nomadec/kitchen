// The source poll, the `sources` step of the tick, exercised through `kitchen up --foreground --once`:
// scripted source beads, gh issue lists and a JSONL file in; the order and entry phase of each new item
// out, through the bd calls intake issues, and the cursor note advanced on the source bead after each.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

const EXPEDITOR = ["--actor", "sona/expeditor"];
const ISSUE = (n: number) => `https://github.com/nomadec/kitchen/issues/${n}`;

function kitchen(t: { after(fn: () => void): void }, table: ScriptedAnswer[]) {
  const host = initialisedHost(t, table);
  const run = () => main(["up", "--foreground", "--once"], host.deps);
  /** Every bd call's argv after `bd`, actor included. */
  const bd = () => host.runner.calls.filter((c) => c.argv[0] === "bd").map((c) => c.argv.slice(1));
  const gh = () => host.runner.calls.filter((c) => c.argv[0] === "gh").map((c) => c.argv);
  const orders = () => bd().filter((argv) => argv[2] === "create" && argv[5] === "epic");
  const cursors = () => bd().filter((argv) => argv[2] === "update" && argv[4] === "--notes").map((argv) => argv[5] ?? "");
  const logFile = path.join(host.home, ".local", "state", "kitchen", "expeditor.jsonl");
  const log = (): Record<string, unknown>[] =>
    fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...host, run, bd, gh, orders, cursors, log };
}

const PHASE_TEXT = (slug: string, entry: string) =>
  `---\nphase: ${slug}\nskill: umka:${slug}\nfrom: []\nto: []\nartifact: a PR\nmodel: claude-opus-5\nentry: [${entry}]\nbudget:\n  usd: 5\n  effort: high\n---\n# ${slug}\n`;

const UMKA: ScriptedAnswer = {
  command: "bd", args: [...EXPEDITOR, "list", "--type", "phase"],
  stdout: JSON.stringify([
    { id: "kitchen-1", title: "umka/sort", status: "open", issue_type: "phase", labels: ["rev:a1b2c3d"], description: PHASE_TEXT("sort", "unsorted") },
    { id: "kitchen-2", title: "umka/grill", status: "open", issue_type: "phase", labels: ["rev:a1b2c3d"], description: PHASE_TEXT("grill", "idea") },
  ]),
};

const OVEN = {
  id: "kitchen-10", title: "sona/oven", status: "open", issue_type: "station", labels: ["owner:sona", "host:sona-laptop", "cap:2"],
  notes: `offers: nomadec/kitchen checked out\n\n\`\`\`json\n${JSON.stringify({
    provider: "claude", models: ["claude-opus-5"], auth: "subscription", plugins: [], skills: [],
    repositories: [{ slug: "nomadec/kitchen", path: "/home/sona/src/kitchen" }], worktrees: "per-order", cap: 2,
    budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [],
  })}\n\`\`\``,
};

const source = (id: string, kind: "github" | "file", target: string, cursor: string, host = "sona-laptop", cls = "unsorted") => ({
  id, title: `${kind}:${target}`, status: "open", issue_type: "source", labels: ["owner:sona", `host:${host}`, `kind:${kind}`],
  notes: `target: ${target}\nrecipe: umka\nclass: ${cls}\ncursor: ${cursor}`.replace(/ $/, ""),
});

/** The tick's own reads: no gate open, no closed pass, no stale lease, no phase ready and no turn running. */
const QUIET: ScriptedAnswer[] = [
  { command: "bd", args: [...EXPEDITOR, "gate", "check", "--json"], stdout: "No open gates found.\n" },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "gate"], stdout: "[]" },
  { command: "bd", args: [...EXPEDITOR, "reclaim", "--json"], stdout: '{"count":0,"reclaimed":null,"schema_version":1,"scoped":false}' },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "station", "--label", "owner:sona", "--label", "host:sona-laptop"], stdout: JSON.stringify([OVEN]) },
  { command: "bd", args: [...EXPEDITOR, "ready", "--assignee", "sona/oven"], stdout: "[]" },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--status", "in_progress"], stdout: "[]" },
  { command: "bd", args: [...EXPEDITOR, "list", "--assignee", "sona/oven", "--status", "in_progress"], stdout: "[]" },
];

/** What intake reads: the recipe and the owner's stations. */
const REGISTERED: ScriptedAnswer[] = [
  UMKA,
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "station", "--label", "owner:sona", "--limit"], stdout: JSON.stringify([OVEN]) },
];

const sources = (...rows: object[]): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--type", "source", "--label", "owner:sona", "--label", "host:sona-laptop"], stdout: JSON.stringify(rows),
});
const noOrderFor = (ref: string, contains: string): ScriptedAnswer[] => [
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--external-ref", ref], stdout: "[]" },
  { command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--external-contains", contains], stdout: "[]" },
];
const orderFor = (ref: string, id: string, title: string): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "list", "--type", "epic", "--label", "loop", "--external-ref", ref],
  stdout: JSON.stringify([{ id, title, status: "open", issue_type: "epic", labels: ["loop"], external_ref: ref, notes: "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: unsorted" }]),
});
const created = (id: string, title: string, type: string): ScriptedAnswer => ({
  command: "bd", args: [...EXPEDITOR, "create", title, "--type", type], stdout: JSON.stringify({ id, title, status: "open", issue_type: type }),
});
const shown = (bead: object & { id: string }): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "show", bead.id], stdout: JSON.stringify([bead]) });
const advanced = (id: string, answer: Partial<ScriptedAnswer> = {}): ScriptedAnswer => ({ command: "bd", args: [...EXPEDITOR, "update", id, "--notes"], stdout: "[]", ...answer });

const issue = (n: number, title: string, updatedAt: string) => ({
  number: n, title, body: `${title} body.`, url: ISSUE(n), labels: [{ name: "bug" }], updatedAt,
});
const issues = (search: string, ...rows: object[]): ScriptedAnswer => ({
  command: "gh", args: ["issue", "list", "--repo", "nomadec/kitchen", "--state", "all", "--limit", "200", "--search", search], stdout: JSON.stringify(rows),
});

const GITHUB = source("kitchen-5", "github", "nomadec/kitchen", "2026-01-01T00:00:00Z");

test("a GitHub source poll with two issues updated since the cursor lays two orders with the source's recipe and class, the entry phase of each, and advances the cursor to each issue's update time in turn", async (t) => {
  const k = kitchen(t, [
    ...QUIET, ...REGISTERED,
    sources(GITHUB),
    issues("sort:updated-asc updated:>=2026-01-01T00:00:00Z", issue(7, "Stale cookie", "2026-01-02T10:00:00Z"), issue(8, "Blank page", "2026-01-03T11:30:00Z")),
    ...noOrderFor(ISSUE(7), "nomadec/kitchen/issues/7"),
    ...noOrderFor(ISSUE(8), "nomadec/kitchen/issues/8"),
    created("kitchen-20", "Stale cookie", "epic"),
    created("kitchen-21", "sort: Stale cookie", "task"),
    created("kitchen-30", "Blank page", "epic"),
    created("kitchen-31", "sort: Blank page", "task"),
    shown(GITHUB),
    advanced("kitchen-5"),
  ]);

  const code = await k.run();

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.gh(), [["gh", "issue", "list", "--repo", "nomadec/kitchen", "--state", "all", "--limit", "200",
    "--search", "sort:updated-asc updated:>=2026-01-01T00:00:00Z", "--json", "number,title,body,url,updatedAt"]]);
  assert.deepEqual(k.orders(), [
    [...EXPEDITOR, "create", "Stale cookie", "--type", "epic", "--labels", "loop",
      "--notes", "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: unsorted", "--description", "Stale cookie body.", "--external-ref", ISSUE(7), "--json"],
    [...EXPEDITOR, "create", "Blank page", "--type", "epic", "--labels", "loop",
      "--notes", "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: unsorted", "--description", "Blank page body.", "--external-ref", ISSUE(8), "--json"],
  ], "the class is the source's, not the issue's bug label");
  const phases = k.bd().filter((argv) => argv[2] === "create" && argv[5] === "task");
  assert.deepEqual(phases.map((argv) => [argv[3], argv[argv.indexOf("--parent") + 1], argv[argv.indexOf("--assignee") + 1]]), [
    ["sort: Stale cookie", "kitchen-20", "sona/oven"],
    ["sort: Blank page", "kitchen-30", "sona/oven"],
  ], "the entry phase for unsorted is laid for each");
  assert.deepEqual(k.cursors(), [
    "target: nomadec/kitchen\nrecipe: umka\nclass: unsorted\ncursor: 2026-01-02T10:00:00Z",
    "target: nomadec/kitchen\nrecipe: umka\nclass: unsorted\ncursor: 2026-01-03T11:30:00Z",
  ]);
  const writes = k.bd().filter((argv) => argv[2] === "create" || argv[2] === "update").map((argv) => argv.slice(2, 4).join(" "));
  assert.deepEqual(writes, [
    "create Stale cookie", "create sort: Stale cookie", "update kitchen-5",
    "create Blank page", "create sort: Blank page", "update kitchen-5",
  ], "the cursor advances after each order, not once at the end");
  const items = k.log().filter((line) => line.step === "sources" && line.item);
  assert.deepEqual(items.map((line) => [line.source, line.item, line.order, line.laid, line.cursor]), [
    ["kitchen-5", ISSUE(7), "kitchen-20", "kitchen-21", "2026-01-02T10:00:00Z"],
    ["kitchen-5", ISSUE(8), "kitchen-30", "kitchen-31", "2026-01-03T11:30:00Z"],
  ]);
});

test("a JSONL source with three lines and an offset at line one lays an order per remaining line, an issue URL read through gh and free text as itself, and leaves the offset at three", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-intake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "intake.jsonl");
  fs.writeFileSync(file, ['"Already an order"', JSON.stringify(ISSUE(7)), '"Let a venue be booked from the course page"', ""].join("\n"));
  const JSONL = source("kitchen-6", "file", file, "1", "sona-laptop", "idea");
  const j = kitchen(t, [
    ...QUIET, ...REGISTERED,
    sources(JSONL),
    { command: "gh", args: ["issue", "view", ISSUE(7)], stdout: JSON.stringify({ title: "Stale cookie", body: "Stale cookie body.", url: ISSUE(7), labels: [{ name: "bug" }] }) },
    ...noOrderFor(ISSUE(7), "nomadec/kitchen/issues/7"),
    ...noOrderFor("text:Let a venue be booked from the course page", "Let a venue be booked from the course page"),
    created("kitchen-20", "Stale cookie", "epic"),
    created("kitchen-21", "grill: Stale cookie", "task"),
    created("kitchen-30", "Let a venue be booked from the course page", "epic"),
    created("kitchen-31", "grill: Let a venue be booked from the course page", "task"),
    shown(JSONL),
    advanced("kitchen-6"),
  ]);

  const code = await j.run();

  assert.equal(code, 0, j.err.join(""));
  assert.deepEqual(j.orders().map((argv) => [argv[3], argv[argv.indexOf("--external-ref") + 1], argv[argv.indexOf("--notes") + 1]]), [
    ["Stale cookie", ISSUE(7), "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: idea"],
    ["Let a venue be booked from the course page", "text:Let a venue be booked from the course page", "repos: \nrecipe: umka rev:a1b2c3d\nclass: idea"],
  ], "the class is the source's idea, not the issue's bug");
  assert.deepEqual(j.cursors().map((notes) => notes.split("\n").at(-1)), ["cursor: 2", "cursor: 3"]);
});

test("an item that already has an order lays none and still advances the cursor past it", async (t) => {
  const k = kitchen(t, [
    ...QUIET, ...REGISTERED,
    sources(GITHUB),
    issues("sort:updated-asc updated:>=2026-01-01T00:00:00Z", issue(7, "Stale cookie", "2026-01-02T10:00:00Z")),
    orderFor(ISSUE(7), "kitchen-20", "Stale cookie"),
    shown(GITHUB),
    advanced("kitchen-5"),
  ]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.orders(), []);
  assert.deepEqual(k.cursors().map((notes) => notes.split("\n").at(-1)), ["cursor: 2026-01-02T10:00:00Z"]);
  const [line] = k.log().filter((line) => line.step === "sources" && line.item);
  assert.deepEqual({ item: line?.item, existing: line?.existing, cursor: line?.cursor }, { item: ISSUE(7), existing: ["kitchen-20"], cursor: "2026-01-02T10:00:00Z" });
});

test("a source whose host: is another host is not polled: the list is narrowed to this host, and no gh call or order follows", async (t) => {
  const k = kitchen(t, [...QUIET, sources()]);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.bd().filter((argv) => argv[2] === "list" && argv[4] === "source"), [
    [...EXPEDITOR, "list", "--type", "source", "--label", "owner:sona", "--label", "host:sona-laptop", "--limit", "0", "--json"],
  ]);
  assert.deepEqual(k.gh(), []);
  assert.deepEqual(k.orders(), []);
  assert.deepEqual(k.log().find((line) => line.step === "sources" && line.sources)?.sources, []);
});

test("a failure between the order and the cursor advance stops the source with the cursor where it was; the retry finds the order by its reference and advances, so the item has exactly one order", async (t) => {
  const table: ScriptedAnswer[] = [
    ...QUIET, ...REGISTERED,
    sources(GITHUB),
    issues("sort:updated-asc updated:>=2026-01-01T00:00:00Z", issue(7, "Stale cookie", "2026-01-02T10:00:00Z"), issue(8, "Blank page", "2026-01-03T11:30:00Z")),
    ...noOrderFor(ISSUE(7), "nomadec/kitchen/issues/7"),
    ...noOrderFor(ISSUE(8), "nomadec/kitchen/issues/8"),
    created("kitchen-20", "Stale cookie", "epic"),
    created("kitchen-21", "sort: Stale cookie", "task"),
    created("kitchen-30", "Blank page", "epic"),
    created("kitchen-31", "sort: Blank page", "task"),
    shown(GITHUB),
    advanced("kitchen-5", { stdout: "", stderr: "Error: connection reset\n", exitCode: 1 }),
  ];
  const k = kitchen(t, table);

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.orders().map((argv) => argv[3]), ["Stale cookie"], "the second item waits: the first is not behind the cursor yet");
  const failed = k.log().find((line) => line.step === "sources" && line.failed);
  assert.deepEqual({ source: failed?.source, item: failed?.item }, { source: "kitchen-5", item: ISSUE(7) });
  assert.match(String(failed?.failed), /update kitchen-5 [\s\S]* connection reset/);
  assert.deepEqual(k.log().at(-1)?.step, "dispatch", "the tick goes on past the failed source");

  // The retry: the order for issue 7 exists now, and the cursor can be written.
  table.splice(table.indexOf(table.find((row) => row.args.includes("--external-ref") && row.args.includes(ISSUE(7))) as ScriptedAnswer), 1, orderFor(ISSUE(7), "kitchen-20", "Stale cookie"));
  table.splice(table.indexOf(table.find((row) => row.exitCode === 1) as ScriptedAnswer), 1, advanced("kitchen-5"));
  k.runner.calls.length = 0;

  assert.equal(await k.run(), 0, k.err.join(""));

  assert.deepEqual(k.orders().map((argv) => argv[3]), ["Blank page"], "one order for the item that failed to advance, laid on the first run; the next item follows");
  assert.deepEqual(k.cursors().map((notes) => notes.split("\n").at(-1)), ["cursor: 2026-01-02T10:00:00Z", "cursor: 2026-01-03T11:30:00Z"]);
});
