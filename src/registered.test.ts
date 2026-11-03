// The reader of registered stations and sources, exercised through the bd list and bd show calls it
// issues and what it makes of their output: the other direction of kitchen station add and source add.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { expeditorActor, humanActor } from "./actor.ts";
import type { HostConfig } from "./config.ts";
import { readSource, readSources, readStation, readStations } from "./registered.ts";
import { openSpace } from "./space.ts";
import type { Space } from "./space.ts";
import { fakeRunner } from "./testing/index.ts";
import type { ScriptedAnswer } from "./testing/index.ts";

const CONFIG: HostConfig = {
  server: { host: "rbn3", port: 3307, user: "sona", database: "kitchen" },
  credential: "/home/sona/.config/beads/credentials",
  owner: "sona",
  host: "sona-laptop",
};
const ENV = { HOME: "/home/sona", XDG_CONFIG_HOME: "/home/sona/.config" };

// The launch spec kitchen station add writes for the template in docs/registration.md.
const LAUNCH = {
  provider: "claude",
  models: ["claude-opus-5", "claude-sonnet-5"],
  auth: "subscription",
  plugins: ["umka@nomadec", "kitchen@nomadec"],
  skills: ["umka:implement", "umka:review"],
  repositories: [
    { slug: "nomadec/kitchen", path: "/home/sona/src/kitchen" },
    { slug: "sona-is/sona", path: "/home/sona/src/sona" },
  ],
  worktrees: "per-order",
  cap: 2,
  budget: { usd: 5, effort: "high" },
  timeout: "45m",
  secrets: ["GITHUB_TOKEN"],
};
const OFFERS = "nomadec/kitchen and sona-is/sona checked out; Node 24 and Elixir on the path; opus and sonnet";

// Beads as bd 1.3.1 prints them: labels come back sorted, and every row carries fields Kitchen ignores.
const GRILL = {
  id: "kitchen-12",
  title: "sona/grill",
  notes: `offers: ${OFFERS}\n\n\`\`\`json\n${JSON.stringify(LAUNCH, null, 2)}\n\`\`\``,
  status: "open",
  priority: 2,
  issue_type: "station",
  owner: "sona@example.com",
  created_by: "sona",
  labels: ["cap:2", "host:sona-laptop", "owner:sona"],
  dependency_count: 0,
};
const PANTRY = {
  ...GRILL,
  id: "kitchen-13",
  title: "raffy/pantry",
  labels: ["attended", "cap:1", "host:oven", "owner:raffy"],
  notes: "offers: a human present\n\n```json\n{\"provider\":\"claude\",\"models\":[\"claude-opus-5\"],\"auth\":\"subscription\",\"plugins\":[],\"skills\":[],\"repositories\":[],\"worktrees\":\"per-order\",\"cap\":1,\"budget\":{\"usd\":2,\"effort\":\"medium\"},\"timeout\":\"2h\",\"secrets\":[]}\n```",
};
const ISSUES = {
  id: "kitchen-20",
  title: "github:nomadec/kitchen",
  notes: "target: nomadec/kitchen\nrecipe: umka\nclass: unsorted\ncursor:",
  status: "open",
  issue_type: "source",
  labels: ["host:sona-laptop", "kind:github", "owner:sona"],
};
const INTAKE = {
  id: "kitchen-21",
  title: "file:/home/sona/intake.jsonl",
  notes: "target: /home/sona/intake.jsonl\nrecipe: umka\nclass: idea\ncursor: 17",
  status: "open",
  issue_type: "source",
  labels: ["host:rbn3", "kind:file", "owner:sona"],
};

function space(table: readonly ScriptedAnswer[], actor = expeditorActor("sona")): { space: Space; argv: () => string[][] } {
  const runner = fakeRunner(table);
  return { space: openSpace({ runner, env: ENV, config: CONFIG, actor }), argv: () => runner.calls.map((c) => c.argv) };
}

test("the stations of an owner on a host are listed with one bd list and read back whole, launch spec included", async () => {
  const { space: s, argv } = space([
    { command: "bd", args: ["--actor", "sona/expeditor", "list"], stdout: JSON.stringify([GRILL, PANTRY]) },
  ]);

  const stations = await readStations(s, { owner: "sona", host: "sona-laptop" });

  assert.deepEqual(argv(), [
    ["bd", "--actor", "sona/expeditor", "list", "--type", "station", "--label", "owner:sona", "--label", "host:sona-laptop", "--limit", "0", "--json"],
  ]);
  assert.deepEqual(stations, [
    { id: "kitchen-12", title: "sona/grill", owner: "sona", name: "grill", host: "sona-laptop", cap: 2, attended: false, offers: OFFERS, launch: LAUNCH },
    {
      id: "kitchen-13", title: "raffy/pantry", owner: "raffy", name: "pantry", host: "oven", cap: 1, attended: true, offers: "a human present",
      launch: { provider: "claude", models: ["claude-opus-5"], auth: "subscription", plugins: [], skills: [], repositories: [], worktrees: "per-order", cap: 1, budget: { usd: 2, effort: "medium" }, timeout: "2h", secrets: [] },
    },
  ]);
});

test("every station, for the laying turn, is one bd list without a label filter; one station is one bd show", async () => {
  const { space: s, argv } = space([
    { command: "bd", args: ["--actor", "sona", "list"], stdout: JSON.stringify([GRILL]) },
    { command: "bd", args: ["--actor", "sona", "show", "kitchen-13"], stdout: JSON.stringify([PANTRY]) },
  ], humanActor("sona"));

  assert.deepEqual((await readStations(s)).map((st) => st.title), ["sona/grill"]);
  assert.equal((await readStation(s, "kitchen-13")).launch.timeout, "2h");
  assert.deepEqual(argv(), [
    ["bd", "--actor", "sona", "list", "--type", "station", "--limit", "0", "--json"],
    ["bd", "--actor", "sona", "show", "kitchen-13", "--json"],
  ]);
});

test("the sources a host polls are listed by host and read back with their cursor, empty before the first poll", async () => {
  const { space: s, argv } = space([
    { command: "bd", args: ["--actor", "sona/expeditor", "list", "--type", "source", "--label", "host:sona-laptop"], stdout: JSON.stringify([ISSUES]) },
    { command: "bd", args: ["--actor", "sona/expeditor", "list", "--type", "source", "--limit"], stdout: JSON.stringify([ISSUES, INTAKE]) },
    { command: "bd", args: ["--actor", "sona/expeditor", "show", "kitchen-21"], stdout: JSON.stringify([INTAKE]) },
  ]);

  assert.deepEqual(await readSources(s, { host: "sona-laptop" }), [
    { id: "kitchen-20", title: "github:nomadec/kitchen", owner: "sona", host: "sona-laptop", kind: "github", target: "nomadec/kitchen", recipe: "umka", class: "unsorted", cursor: "" },
  ]);
  assert.deepEqual((await readSources(s)).map((src) => src.id), ["kitchen-20", "kitchen-21"]);
  assert.deepEqual(await readSource(s, "kitchen-21"), {
    id: "kitchen-21", title: "file:/home/sona/intake.jsonl", owner: "sona", host: "rbn3", kind: "file", target: "/home/sona/intake.jsonl", recipe: "umka", class: "idea", cursor: "17",
  });
  assert.deepEqual(argv(), [
    ["bd", "--actor", "sona/expeditor", "list", "--type", "source", "--label", "host:sona-laptop", "--limit", "0", "--json"],
    ["bd", "--actor", "sona/expeditor", "list", "--type", "source", "--limit", "0", "--json"],
    ["bd", "--actor", "sona/expeditor", "show", "kitchen-21", "--json"],
  ]);
});

test("a bead that is not what it should be is refused naming the bead and what is missing", async () => {
  const broken: [string, Record<string, unknown>, RegExp][] = [
    ["kitchen-12", { ...GRILL, issue_type: "task" }, /kitchen-12 is a task bead, not a station/],
    ["kitchen-12", { ...GRILL, labels: ["cap:2", "owner:sona"] }, /kitchen-12 carries no host: label/],
    ["kitchen-12", { ...GRILL, labels: ["cap:2", "host:sona-laptop", "owner:raffy"] }, /kitchen-12 is titled sona\/grill, not raffy\/<name>/],
    ["kitchen-12", { ...GRILL, labels: ["cap:many", "host:sona-laptop", "owner:sona"] }, /kitchen-12 carries cap:many, not a whole number of turns/],
    ["kitchen-12", { ...GRILL, notes: `offers: ${OFFERS}` }, /kitchen-12 carries no launch spec/],
    ["kitchen-12", { ...GRILL, notes: "```json\n{}\n```" }, /kitchen-12 carries no offers: line/],
    ["kitchen-12", { ...GRILL, notes: "offers: x\n\n```json\n{\"provider\": \n```" }, /kitchen-12's launch spec is not JSON/],
    ["kitchen-12", { ...GRILL, notes: `offers: x\n\n\`\`\`json\n${JSON.stringify({ ...LAUNCH, models: "opus" })}\n\`\`\`` }, /kitchen-12's launch spec lacks models \(a list of strings\)/],
    ["kitchen-12", { ...GRILL, notes: `offers: x\n\n\`\`\`json\n${JSON.stringify({ ...LAUNCH, timeout: undefined })}\n\`\`\`` }, /kitchen-12's launch spec lacks timeout/],
    ["kitchen-20", { ...ISSUES, issue_type: "station" }, /kitchen-20 is a station bead, not a source/],
    ["kitchen-20", { ...ISSUES, notes: "target: x\nrecipe: umka\nclass: unsorted" }, /kitchen-20 carries no cursor: note/],
    ["kitchen-20", { ...ISSUES, labels: ["owner:sona", "host:rbn3", "kind:jira"] }, /kind jira, not github or file/],
  ];
  for (const [id, bead, message] of broken) {
    const { space: s } = space([{ command: "bd", args: ["--actor", "sona", "show", id], stdout: JSON.stringify([bead]) }], humanActor("sona"));
    const read = id === "kitchen-20" ? readSource : readStation;
    await assert.rejects(() => read(s, id), message);
  }
});

test("the reader runs over the space connection like every other read", async () => {
  const runner = fakeRunner([{ command: "bd", args: ["--actor", "sona", "list"], stdout: "[]" }]);
  await readStations(openSpace({ runner, env: ENV, config: CONFIG, actor: humanActor("sona") }));
  assert.equal(runner.calls[0]?.cwd, path.join("/home/sona/.config", "kitchen", "space"));
  assert.equal(runner.calls[0]?.env?.BEADS_CREDENTIALS_FILE, CONFIG.credential);
});
