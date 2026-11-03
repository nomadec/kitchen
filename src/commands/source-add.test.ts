// kitchen source add, exercised through the one bd create it issues: the source bead with its kind,
// target, recipe, class, the host that polls it and an empty cursor.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], sessionEnv: Record<string, string> = {}) {
  const host = initialisedHost(t, table, { sessionEnv });
  const run = (...argv: string[]) => main(["source", "add", ...argv], host.deps);
  return { ...host, run };
}

const CREATED = (id: string, title: string): ScriptedAnswer => ({
  command: "bd",
  args: ["--actor", "sona", "create"],
  stdout: `{"id":"${id}","title":"${title}","status":"open","issue_type":"source"}`,
});

test("a GitHub source is registered with an empty cursor, the registering host and the default class unsorted", async (t) => {
  const k = kitchen(t, [CREATED("kitchen-20", "github:nomadec/kitchen")]);

  const code = await k.run("--kind", "github", "--target", "nomadec/kitchen", "--recipe", "umka");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.runner.calls, [
    {
      argv: [
        "bd", "--actor", "sona", "create", "github:nomadec/kitchen",
        "--type", "source",
        "--labels", "owner:sona,host:sona-laptop,kind:github",
        "--notes", "target: nomadec/kitchen\nrecipe: umka\nclass: unsorted\ncursor:",
        "--json",
      ],
      ...k.connection,
    },
  ]);
  assert.match(k.out.join(""), /Registered source github:nomadec\/kitchen as kitchen-20, polled by sona-laptop/);
});

test("a file source takes a JSONL path, a class, and --host names another host to poll it", async (t) => {
  const k = kitchen(t, [CREATED("kitchen-21", "file:/home/sona/intake.jsonl")]);

  const code = await k.run("--kind", "file", "--target", "/home/sona/intake.jsonl", "--recipe", "umka", "--class", "idea", "--host", "rbn3");

  assert.equal(code, 0, k.err.join(""));
  const argv = k.runner.calls[0]?.argv ?? [];
  assert.equal(argv[4], "file:/home/sona/intake.jsonl");
  assert.equal(argv[argv.indexOf("--labels") + 1], "owner:sona,host:rbn3,kind:file");
  assert.equal(argv[argv.indexOf("--notes") + 1], "target: /home/sona/intake.jsonl\nrecipe: umka\nclass: idea\ncursor:");
  assert.match(k.out.join(""), /polled by rbn3/);
});

test("a missing kind, target or recipe, an unknown kind or class, is refused naming it, before any bd call", async (t) => {
  const k = kitchen(t, []);
  assert.notEqual(await k.run("--target", "nomadec/kitchen", "--recipe", "umka"), 0);
  assert.match(k.err.at(-1) ?? "", /--kind <github\|file> is required/);
  assert.notEqual(await k.run("--kind", "github", "--recipe", "umka"), 0);
  assert.match(k.err.at(-1) ?? "", /--target <repository slug or JSONL path> is required/);
  assert.notEqual(await k.run("--kind", "github", "--target", "nomadec/kitchen"), 0);
  assert.match(k.err.at(-1) ?? "", /--recipe <name> is required/);
  assert.notEqual(await k.run("--kind", "jira", "--target", "KIT", "--recipe", "umka"), 0);
  assert.match(k.err.at(-1) ?? "", /--kind must be github or file, got jira/);
  assert.notEqual(await k.run("--kind", "github", "--target", "nomadec/kitchen", "--recipe", "umka", "--class", "epic"), 0);
  assert.match(k.err.at(-1) ?? "", /--class must be one of unsorted, question, idea, proposal, spec, ticket, bug, got epic/);
  assert.deepEqual(k.runner.calls, []);
});

test("under a station actor the wrapper refuses the registration and no bd call is issued", async (t) => {
  const k = kitchen(t, [], { BEADS_ACTOR: "sona/grill" });
  assert.notEqual(await k.run("--kind", "github", "--target", "nomadec/kitchen", "--recipe", "umka"), 0);
  assert.match(k.err.join(""), /sona\/grill may not create a source bead: registering .* is a human act/);
  assert.deepEqual(k.runner.calls, []);
});

test("under the expeditor's actor the command refuses too: registration is a human act", async (t) => {
  const k = kitchen(t, [], { BEADS_ACTOR: "sona/expeditor" });
  assert.notEqual(await k.run("--kind", "github", "--target", "nomadec/kitchen", "--recipe", "umka"), 0);
  assert.match(k.err.join(""), /sona\/expeditor may not register a source: registration is a human act/);
  assert.deepEqual(k.runner.calls, []);
});

test("--help prints the usage and issues nothing, even on a host that never ran kitchen init", async (t) => {
  const k = kitchen(t, []);
  fs.rmSync(k.configFile);
  assert.equal(await k.run("--help"), 0);
  assert.match(k.out.join(""), /Usage: kitchen source add/);
  assert.equal(await main(["station", "add", "--help"], k.deps), 0);
  assert.match(k.out.join(""), /Usage: kitchen station add/);
  assert.deepEqual(k.runner.calls, []);
});
