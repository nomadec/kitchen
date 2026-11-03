// kitchen station add, exercised through the one bd create it issues: a template gives the shape, the
// values only this host knows come from the command line, and the result is the station bead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

/** The example template docs/registration.md shows, as a plugin would ship it. */
const TEMPLATE = {
  name: "grill",
  offers: "nomadec/kitchen and sona-is/sona checked out; Node 24 and Elixir on the path; opus and sonnet",
  provider: "claude",
  models: ["claude-opus-5", "claude-sonnet-5"],
  auth: "subscription",
  plugins: ["umka@nomadec", "kitchen@nomadec"],
  skills: ["umka:implement", "umka:review"],
  repositories: ["nomadec/kitchen", "sona-is/sona"],
  worktrees: "per-order",
  budget: { usd: 5, effort: "high" },
};

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], sessionEnv: Record<string, string> = {}) {
  const host = initialisedHost(t, table, { sessionEnv });
  const template = path.join(host.home, "station.json");
  fs.writeFileSync(template, JSON.stringify(TEMPLATE));
  const run = (...argv: string[]) => main(["station", "add", template, ...argv], host.deps);
  return { ...host, run, template };
}

const CREATED: ScriptedAnswer = {
  command: "bd",
  args: ["--actor", "sona", "create"],
  stdout: '{"id":"kitchen-12","title":"sona/grill","status":"open","issue_type":"station"}',
};

test("a template plus the values only this host knows produces one bd create: the title, labels, offers line and the launch spec note", async (t) => {
  const k = kitchen(t, [CREATED]);

  const code = await k.run(
    "--repo", "nomadec/kitchen=/home/sona/src/kitchen",
    "--repo", "sona-is/sona=/home/sona/src/sona",
    "--cap", "2",
    "--timeout", "45m",
    "--secret", "GITHUB_TOKEN",
  );

  assert.equal(code, 0, k.err.join(""));
  const launch = {
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
  assert.deepEqual(k.runner.calls, [
    {
      argv: [
        "bd", "--actor", "sona", "create", "sona/grill",
        "--type", "station",
        "--labels", "owner:sona,host:sona-laptop,cap:2",
        "--notes", `offers: ${TEMPLATE.offers}\n\n\`\`\`json\n${JSON.stringify(launch, null, 2)}\n\`\`\``,
        "--json",
      ],
      ...k.connection,
    },
  ]);
  assert.match(k.out.join(""), /Registered station sona\/grill as kitchen-12/);
});

test("a missing required value is refused with a message naming it, before any bd call", async (t) => {
  const k = kitchen(t, []);
  const kitchenRepo = ["--repo", "nomadec/kitchen=/src/kitchen"];
  const sonaRepo = ["--repo", "sona-is/sona=/src/sona"];
  const complete = [...kitchenRepo, ...sonaRepo, "--cap", "1", "--timeout", "45m"];

  assert.notEqual(await k.run(...kitchenRepo, ...sonaRepo, "--timeout", "45m"), 0);
  assert.match(k.err.at(-1) ?? "", /--cap <n> is required/);
  assert.notEqual(await k.run(...kitchenRepo, ...sonaRepo, "--cap", "1"), 0);
  assert.match(k.err.at(-1) ?? "", /--timeout <duration> is required/);
  assert.notEqual(await k.run(...kitchenRepo, "--cap", "1", "--timeout", "45m"), 0);
  assert.match(k.err.at(-1) ?? "", /--repo sona-is\/sona=<local path> is required: the template offers sona-is\/sona/);
  assert.notEqual(await k.run(...complete, "--repo", "nomadec/marketplace=/src/marketplace"), 0);
  assert.match(k.err.at(-1) ?? "", /the template does not offer nomadec\/marketplace/);
  assert.notEqual(await k.run(...complete, "--cap", "two"), 0);
  assert.match(k.err.at(-1) ?? "", /--cap must be a whole number of turns, got two/);
  assert.notEqual(await k.run(...complete, "--cap", "0"), 0);
  assert.match(k.err.at(-1) ?? "", /--cap must be a whole number of turns, got 0/);
  assert.notEqual(await k.run(...complete, "--timeout", "soon"), 0);
  assert.match(k.err.at(-1) ?? "", /--timeout must be a duration such as 45m/);
  assert.deepEqual(k.runner.calls, []);
});

test("a template that lacks a field is refused naming the field; a template without a name needs --name", async (t) => {
  const k = kitchen(t, []);
  const { name: _name, ...nameless } = TEMPLATE;
  fs.writeFileSync(k.template, JSON.stringify(nameless));
  const values = ["--repo", "nomadec/kitchen=/src/kitchen", "--repo", "sona-is/sona=/src/sona", "--cap", "1", "--timeout", "45m"];
  assert.notEqual(await k.run(...values), 0);
  assert.match(k.err.at(-1) ?? "", /--name <name> is required: the template gives no name/);

  const { models: _models, ...modelless } = TEMPLATE;
  fs.writeFileSync(k.template, JSON.stringify(modelless));
  assert.notEqual(await k.run(...values), 0);
  assert.match(k.err.at(-1) ?? "", /station\.json lacks models/);

  assert.notEqual(await main(["station", "add", path.join(k.home, "missing.json"), ...values], k.deps), 0);
  assert.match(k.err.at(-1) ?? "", /no station template at .*missing\.json/);
  assert.deepEqual(k.runner.calls, []);
});

test("the values override the template's name and offers, --owner and --host the config, and --attended labels the station", async (t) => {
  const k = kitchen(t, [{ command: "bd", args: ["--actor", "sona", "create"], stdout: '{"id":"kitchen-13","title":"raffy/pantry","status":"open","issue_type":"station"}' }]);

  const code = await k.run(
    "--name", "pantry", "--owner", "raffy", "--host", "oven", "--offers", "a human present; sona checked out", "--attended",
    "--repo", "nomadec/kitchen=/home/raffy/kitchen", "--repo", "sona-is/sona=/home/raffy/sona", "--cap", "1", "--timeout", "2h",
  );

  assert.equal(code, 0, k.err.join(""));
  const argv = k.runner.calls[0]?.argv ?? [];
  assert.equal(argv[4], "raffy/pantry");
  assert.equal(argv[argv.indexOf("--labels") + 1], "owner:raffy,host:oven,cap:1,attended");
  const notes = argv[argv.indexOf("--notes") + 1] ?? "";
  assert.match(notes, /^offers: a human present; sona checked out\n/);
  const launch = JSON.parse(/```json\n([\s\S]*)\n```/.exec(notes)?.[1] ?? "{}");
  assert.equal(launch.cap, 1);
  assert.equal(launch.timeout, "2h");
  assert.deepEqual(launch.secrets, []);
  assert.match(k.out.join(""), /Registered station raffy\/pantry as kitchen-13 on oven/);
});

test("a plugin directory holding station.json is a template too", async (t) => {
  const k = kitchen(t, [CREATED]);
  const plugin = path.join(k.home, "umka");
  fs.mkdirSync(plugin);
  fs.renameSync(k.template, path.join(plugin, "station.json"));
  const code = await main(
    ["station", "add", plugin, "--repo", "nomadec/kitchen=/src/kitchen", "--repo", "sona-is/sona=/src/sona", "--cap", "2", "--timeout", "45m"],
    k.deps,
  );
  assert.equal(code, 0, k.err.join(""));
  assert.equal(k.runner.calls[0]?.argv[4], "sona/grill");
});

test("under a station actor the wrapper refuses the registration and no bd call is issued", async (t) => {
  const k = kitchen(t, [], { BEADS_ACTOR: "sona/grill" });
  const code = await k.run("--repo", "nomadec/kitchen=/src/kitchen", "--repo", "sona-is/sona=/src/sona", "--cap", "2", "--timeout", "45m");
  assert.notEqual(code, 0);
  assert.match(k.err.join(""), /sona\/grill may not create a station bead: registering .* is a human act/);
  assert.deepEqual(k.runner.calls, []);
});

test("under the expeditor's actor the command refuses too: registration is a human act", async (t) => {
  const k = kitchen(t, [], { BEADS_ACTOR: "sona/expeditor" });
  assert.notEqual(await k.run("--repo", "nomadec/kitchen=/src/kitchen", "--repo", "sona-is/sona=/src/sona", "--cap", "2", "--timeout", "45m"), 0);
  assert.match(k.err.join(""), /sona\/expeditor may not register a station: registration is a human act/);
  assert.deepEqual(k.runner.calls, []);
});

test("a host that never ran kitchen init is told so", async (t) => {
  const k = kitchen(t, []);
  fs.rmSync(k.configFile);
  assert.notEqual(await k.run("--cap", "1", "--timeout", "45m"), 0);
  assert.match(k.err.join(""), /run kitchen init first/);
  assert.deepEqual(k.runner.calls, []);
});
