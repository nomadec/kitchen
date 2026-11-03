// kitchen pass, exercised through the CLI: scripted open gates and orders in; the pass listing out,
// and the close of the chosen pass with the human's word as its reason, under the human actor; a
// station or expeditor actor refused before any call.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Readable } from "node:stream";
import { main } from "../cli.ts";
import { initialisedHost } from "../testing/index.ts";
import type { HostOptions, ScriptedAnswer } from "../testing/index.ts";

const OWNER = ["--actor", "sona"];

function kitchen(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], options: HostOptions & { typed?: string } = {}) {
  const host = initialisedHost(t, table, options);
  if (options.typed !== undefined) host.deps.stdin = Readable.from([options.typed]);
  const run = (...argv: string[]) => main(["pass", ...argv], host.deps);
  /** Every bd call's argv after `bd`, actor included. */
  const bd = () => host.runner.calls.filter((c) => c.argv[0] === "bd").map((c) => c.argv.slice(1));
  const closes = () => bd().filter((argv) => argv[2] === "close");
  return { ...host, run, bd, closes };
}

/** A pass as `bd list --type gate` prints it: the brief after `Reason:` in the description, the order as parent. */
const pass = (id: string, title: string, order: string, brief: string, labels: string[] = ["briefed"]) => ({
  id, title, status: "open", issue_type: "gate", await_type: "human", assignee: "sona", parent: order, labels,
  description: `Ad-hoc gate blocking ${order}.3\n\nReason: ${brief}`,
});
const order = (id: string, title: string) => ({ id, title, status: "open", issue_type: "epic", labels: ["loop"], notes: "repos: nomadec/kitchen\nrecipe: umka rev:a1b2c3d\nclass: idea" });

const gates = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "list", "--type", "gate", "--status", "open"], stdout: JSON.stringify(rows) });
const orders = (...rows: object[]): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "list", "--type", "epic", "--label", "loop"], stdout: JSON.stringify(rows) });
const closed = (id: string): ScriptedAnswer => ({ command: "bd", args: [...OWNER, "close", id], stdout: JSON.stringify([{ id, status: "closed", issue_type: "gate", await_type: "human" }]) });

const GRILL_PASS = pass("kitchen-22", "decide: grill", "kitchen-20", "The grill found two shapes for the cookie jar.\nPick wide or tall.");
const SPEC_PASS = pass("kitchen-32", "decide: spec", "kitchen-30", "The spec is drafted at docs/spec.md. Ship it, or name what is missing.");

const TWO_PASSES: ScriptedAnswer[] = [gates(GRILL_PASS, SPEC_PASS), orders(order("kitchen-20", "Stale cookie"), order("kitchen-30", "Cookie jar"))];

test("kitchen pass <id> <word> closes that pass with the word as its reason under the human actor, and says the phase behind it is ready", async (t) => {
  const k = kitchen(t, [...TWO_PASSES, closed("kitchen-32")]);

  const code = await k.run("kitchen-32", "ship", "it");

  assert.equal(code, 0, k.err.join(""));
  assert.deepEqual(k.closes(), [[...OWNER, "close", "kitchen-32", "--reason", "ship it", "--json"]]);
  for (const call of k.runner.calls) {
    assert.deepEqual({ cwd: call.cwd, env: call.env }, k.connection);
    assert.equal(call.argv[1], "--actor");
  }
  assert.match(k.out.join(""), /Closed kitchen-32 \(decide: spec\) on order kitchen-30 \(Cookie jar\) with: ship it\nThe phase behind it is ready for the next tick\.\n$/);
});

test("kitchen pass with no arguments lists every open briefed pass numbered, each with its order and brief, asks which and for the word, and closes the chosen one", async (t) => {
  const k = kitchen(t, [...TWO_PASSES, closed("kitchen-32")], { typed: "2\nship it\n" });

  const code = await k.run();

  assert.equal(code, 0, k.err.join(""));
  assert.equal(
    k.out.join(""),
    [
      "2 open passes for sona:",
      "",
      "1. kitchen-22  decide: grill",
      "   order kitchen-20 (Stale cookie)",
      "   The grill found two shapes for the cookie jar.",
      "   Pick wide or tall.",
      "",
      "2. kitchen-32  decide: spec",
      "   order kitchen-30 (Cookie jar)",
      "   The spec is drafted at docs/spec.md. Ship it, or name what is missing.",
      "",
      "Pass (number or id, empty to leave them open): Your word: Closed kitchen-32 (decide: spec) on order kitchen-30 (Cookie jar) with: ship it",
      "The phase behind it is ready for the next tick.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(k.closes(), [[...OWNER, "close", "kitchen-32", "--reason", "ship it", "--json"]]);
});

test("a pass chosen by id at the question, an empty answer, and a terminal with no input: the first closes, the other two leave every pass open", async (t) => {
  const byId = kitchen(t, [...TWO_PASSES, closed("kitchen-22")], { typed: "kitchen-22\nwide\n" });
  assert.equal(await byId.run(), 0, byId.err.join(""));
  assert.deepEqual(byId.closes(), [[...OWNER, "close", "kitchen-22", "--reason", "wide", "--json"]]);

  const left = kitchen(t, TWO_PASSES, { typed: "\n" });
  assert.equal(await left.run(), 0, left.err.join(""));
  assert.deepEqual(left.closes(), []);
  assert.match(left.out.at(-1) ?? "", /^No pass closed\.\n$/);

  const piped = kitchen(t, TWO_PASSES);
  assert.equal(await piped.run(), 0, piped.err.join(""));
  assert.deepEqual(piped.closes(), []);
  assert.match(piped.out.join(""), /^2 open passes for sona:\n/);
  assert.doesNotMatch(piped.out.join(""), /Pass \(number or id/, "nothing is asked of a terminal with no input");
});

test("a session running as a station or as the expeditor is refused before any call: a pass closes only under a person's name", async (t) => {
  for (const actor of ["sona/desk", "sona/expeditor"]) {
    const k = kitchen(t, [...TWO_PASSES, closed("kitchen-32")], { sessionEnv: { BEADS_ACTOR: actor } });
    assert.equal(await k.run("kitchen-32", "ship it"), 1);
    assert.match(k.err.at(-1) ?? "", new RegExp(`^kitchen pass: ${actor} may not answer a pass: a pass closes only under a person's name \\(a cooperative rule, not a security boundary: docs/trust-model.md\\)\n$`));
    assert.equal(k.runner.calls.length, 0);
  }
});

test("a pass without a brief is listed as not yet briefed and can still be answered by id; a typed gate is no pass; an empty space says so", async (t) => {
  const bare = { id: "kitchen-42", title: "turn failed: reproduce", status: "open", issue_type: "gate", await_type: "human", assignee: "sona", parent: "kitchen-40", description: "Ad-hoc gate blocking kitchen-41" };
  const timer = { id: "kitchen-43", title: "wait: a day", status: "open", issue_type: "gate", await_type: "timer", description: "Ad-hoc gate blocking kitchen-41\n\nReason: a day" };
  const k = kitchen(t, [gates(GRILL_PASS, bare, timer), orders(order("kitchen-20", "Stale cookie")), closed("kitchen-42")], { typed: "retry\n" });

  assert.equal(await k.run(), 1);
  assert.equal(k.out[0], "1 open pass for sona:\n\n1. kitchen-22  decide: grill\n   order kitchen-20 (Stale cookie)\n   The grill found two shapes for the cookie jar.\n   Pick wide or tall.\n\nNot yet briefed: kitchen-42 (turn failed: reproduce)\n");
  assert.deepEqual(k.closes(), [], "retry was read as the pass choice, which no pass matches");
  assert.match(k.err.at(-1) ?? "", /kitchen pass: retry is not an open pass/);

  const answered = kitchen(t, [gates(GRILL_PASS, bare, timer), orders(order("kitchen-20", "Stale cookie")), closed("kitchen-42")]);
  assert.equal(await answered.run("kitchen-42", "retry"), 0, answered.err.join(""));
  assert.deepEqual(answered.closes(), [[...OWNER, "close", "kitchen-42", "--reason", "retry", "--json"]]);
  assert.match(answered.out.at(-1) ?? "", /^Closed kitchen-42 \(turn failed: reproduce\) on order kitchen-40 with: retry\n/);

  const empty = kitchen(t, [gates(), orders()], { typed: "1\n" });
  assert.equal(await empty.run(), 0, empty.err.join(""));
  assert.equal(empty.out.join(""), "No open briefed pass for sona.\n");
});

test("an id that is not an open pass, a missing word, a close bd refuses and a host without kitchen init are each refused naming the gap", async (t) => {
  const unknown = kitchen(t, TWO_PASSES);
  assert.equal(await unknown.run("kitchen-99", "ship it"), 1);
  assert.match(unknown.err.at(-1) ?? "", /kitchen pass: kitchen-99 is not an open pass: kitchen pass lists them/);
  assert.deepEqual(unknown.closes(), []);

  const wordless = kitchen(t, TWO_PASSES);
  assert.equal(await wordless.run("kitchen-32"), 1);
  assert.match(wordless.err.at(-1) ?? "", /kitchen pass: a word is required: kitchen-32 stays open/);
  assert.match(wordless.out.join(""), /kitchen-32  decide: spec\n   order kitchen-30 \(Cookie jar\)\n   The spec is drafted/, "the brief is shown before the word is asked");
  assert.deepEqual(wordless.closes(), []);

  const refused = kitchen(t, [...TWO_PASSES, { command: "bd", args: [...OWNER, "close", "kitchen-32"], stderr: "Error: issue kitchen-32 is already closed\n", exitCode: 1 }]);
  assert.equal(await refused.run("kitchen-32", "ship it"), 1);
  assert.match(refused.err.at(-1) ?? "", /kitchen pass: bd --actor sona close kitchen-32 --reason ship it --json failed \(exit 1\): Error: issue kitchen-32 is already closed/);

  const uninitialised = kitchen(t, []);
  fs.rmSync(uninitialised.configFile);
  assert.equal(await uninitialised.run(), 1);
  assert.match(uninitialised.err.at(-1) ?? "", /run kitchen init first/);
  assert.equal(uninitialised.runner.calls.length, 0);
  assert.equal(await uninitialised.run("--help"), 0);
  assert.match(uninitialised.out.at(-1) ?? "", /^Usage: kitchen pass \[<pass> \[<word>\.\.\.\]\]/);
});
