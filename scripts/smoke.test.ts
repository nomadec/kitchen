// The smoke's fixture recipe and station template, exercised through the registration commands the
// smoke runs them through: the bundle registers as three phase beads (the entry phase for idea, the
// pass and the phase behind it) and the template registers an unattended station that offers no
// repository, so the smoke's order touches no code. The smoke itself (scripts/smoke.ts) is run by hand
// against a real bd and a real claude; its run record is docs/qa/issue-1-spec-review.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../src/cli.ts";
import { initialisedHost } from "../src/testing/index.ts";
import type { ScriptedAnswer } from "../src/testing/index.ts";

const FIXTURE = path.resolve(import.meta.dirname, "smoke-fixture");

const NO_PHASES: ScriptedAnswer = { command: "bd", args: ["--actor", "sona", "list"], stdout: "[]" };
const CREATED: ScriptedAnswer = { command: "bd", args: ["--actor", "sona", "create"], stdout: '{"id":"kitchen-7","issue_type":"phase","status":"open"}' };

const phaseFile = (slug: string) => fs.readFileSync(path.join(FIXTURE, "phases", `${slug}.md`), "utf8");

test("the fixture bundle registers as three phase beads: the entry phase for idea, the pass and the phase behind it", async (t) => {
  const host = initialisedHost(t, [NO_PHASES, CREATED]);

  const code = await main(["recipe", "add", FIXTURE], host.deps);

  assert.equal(code, 0, host.err.join(""));
  const creates = host.runner.calls.slice(1).map((c) => c.argv);
  assert.deepEqual(creates.map((argv) => argv[4]), ["smoke/approve", "smoke/confirm", "smoke/greet"]);
  for (const argv of creates) {
    assert.equal(argv[argv.indexOf("--type") + 1], "phase");
    assert.match(argv[argv.indexOf("--labels") + 1] ?? "", /^rev:[0-9a-f]{7}$/);
  }
  assert.match(host.out.join(""), /Registered smoke rev:[0-9a-f]{7} with 3 phases/);

  // What the turn driver and intake read from the registered text: the entry class, the pass with
  // its Apply section, and the phase behind it that closes the order.
  assert.match(phaseFile("greet"), /^entry: \[idea\]$/m, "greet is the entry phase for an idea");
  assert.match(phaseFile("approve"), /^skill: human$/m, "approve is a pass phase");
  assert.match(phaseFile("approve"), /^\*\*Apply:\*\*/m, "the pass phase carries the Apply section the turn behind it runs");
  assert.match(phaseFile("confirm"), /^from: \[approve\]$/m, "confirm is the phase behind the pass");
  assert.match(phaseFile("confirm"), /Order done: smoke/, "the last phase closes the order with its result line");
});

test("the fixture station template registers an unattended station with no repository, so the order touches no code", async (t) => {
  const host = initialisedHost(t, [
    { command: "bd", args: ["--actor", "sona", "create"], stdout: '{"id":"kitchen-12","title":"sona/smoke","status":"open","issue_type":"station"}' },
  ]);

  const code = await main(["station", "add", FIXTURE, "--cap", "1", "--timeout", "10m"], host.deps);

  assert.equal(code, 0, host.err.join(""));
  const [create] = host.runner.calls;
  assert.ok(create);
  assert.deepEqual(create.argv.slice(0, 7), ["bd", "--actor", "sona", "create", "sona/smoke", "--type", "station"]);
  assert.equal(create.argv[create.argv.indexOf("--labels") + 1], "owner:sona,host:sona-laptop,cap:1", "unattended: no attended label");
  const notes = create.argv[create.argv.indexOf("--notes") + 1] ?? "";
  const launch = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(notes)?.[1] ?? "{}") as { repositories: unknown; models: unknown; cap: unknown };
  assert.deepEqual(launch.repositories, []);
  assert.deepEqual(launch.models, ["claude-sonnet-5"]);
  assert.equal(launch.cap, 1);
  assert.match(host.out.join(""), /Registered station sona\/smoke as kitchen-12/);
});
