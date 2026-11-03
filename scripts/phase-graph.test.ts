// The phase graph script, exercised through the bd calls it issues and the markdown it prints:
// scripted bd list and bd show answers in, a Mermaid graph and the derived paths out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeHostConfig } from "../src/config.ts";
import { fakeRunner } from "../src/testing/index.ts";
import type { ScriptedAnswer } from "../src/testing/index.ts";
import { phaseGraph } from "./phase-graph.ts";

interface Scope {
  after(fn: () => void): void;
}

function host(t: Scope, table: readonly ScriptedAnswer[], withConfig = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-graph-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  if (withConfig) {
    writeHostConfig(env, {
      server: { host: "rbn3", port: 3307, user: "sona", database: "kitchen" },
      credential: "/home/sona/.config/beads/credentials",
      owner: "sona",
      host: "sona-laptop",
    });
  }
  const out: string[] = [];
  const err: string[] = [];
  const runner = fakeRunner(table);
  return {
    home,
    runner,
    out,
    err,
    run: () => phaseGraph({ runner, env, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }),
  };
}

// The umka bundle: explore loops through research, research leads to a pass and the pass to spec,
// spec fans out one slice per ticket, and slice crosses into the triage recipe's review phase.
const EXPLORE = `---
phase: explore
skill: umka:explore
model: claude-opus-5
entry: [question, idea]
from: [research]
to:
  - phase: research
    when: the question needs a source read
  - phase: approve-proposal
artifact: the proposal
budget:
  usd: 4
  effort: high
---
# explore
`;

const RESEARCH = `---
phase: research
skill: umka:research
model: claude-sonnet-5
from: [explore]
to:
  - phase: explore
    when: the "source" is read
artifact: the notes
budget:
  usd: 2
  effort: medium
---
# research
`;

const APPROVE_PROPOSAL = `---
phase: approve-proposal
skill: human
from: [explore]
to:
  - phase: spec
artifact: the pass is closed
ask: the proposal in five lines
skip when: the proposal changes nothing a human has to see
---
# approve proposal
`;

const SPEC = `---
phase: spec
skill: umka:spec
model: claude-opus-5
from: [approve-proposal]
to:
  - phase: slice
    per: ticket
artifact: the spec
budget:
  usd: 8
  effort: high
---
# spec
`;

const SLICE = `---
phase: slice
skill: umka:slice
model: claude-sonnet-5
from: [spec]
to:
  - phase: triage/review
    when: the slice touches a shared module
    per: module
artifact: the ticket
budget:
  usd: 2
  effort: medium
---
# slice
`;

const REVIEW = `---
phase: review
skill: triage:review
model: claude-sonnet-5
entry: [ticket]
from: []
to: []
artifact: the verdict
budget:
  usd: 1
  effort: low
---
# review
`;

const BEADS = [
  { id: "kitchen-11", title: "umka/explore", labels: ["rev:a1b2c3d"], text: EXPLORE },
  { id: "kitchen-12", title: "umka/research", labels: ["rev:a1b2c3d"], text: RESEARCH },
  { id: "kitchen-13", title: "umka/approve-proposal", labels: ["rev:a1b2c3d"], text: APPROVE_PROPOSAL },
  { id: "kitchen-14", title: "umka/spec", labels: ["rev:a1b2c3d"], text: SPEC },
  { id: "kitchen-15", title: "umka/slice", labels: ["rev:a1b2c3d"], text: SLICE },
  { id: "kitchen-21", title: "triage/review", labels: ["rev:9f8e7d6"], text: REVIEW },
];

/** An earlier umka revision, labelled superseded, that the graph must not draw. */
const SUPERSEDED = { id: "kitchen-3", title: "umka/sort", labels: ["rev:0000000", "superseded"], text: "" };

const listed = (bead: { id: string; title: string; labels: string[] }) =>
  ({ id: bead.id, title: bead.title, status: "open", issue_type: "phase", labels: bead.labels });

const TABLE: ScriptedAnswer[] = [
  { command: "bd", args: ["--actor", "sona", "list"], stdout: JSON.stringify([SUPERSEDED, ...BEADS].map(listed)) },
  ...BEADS.map((bead): ScriptedAnswer => ({
    command: "bd",
    args: ["--actor", "sona", "show", bead.id],
    stdout: JSON.stringify([{ ...listed(bead), description: bead.text }]),
  })),
];

const CONNECTION = (home: string) => ({
  cwd: path.join(home, ".config", "kitchen", "space"),
  env: { BEADS_CREDENTIALS_FILE: "/home/sona/.config/beads/credentials" },
});

const lines = (out: string[]) => out.join("").split("\n");

test("the script lists the phase beads under the owner's actor and shows each one of the latest revisions", async (t) => {
  const h = host(t, TABLE);

  const code = await h.run();

  assert.equal(code, 0, h.err.join(""));
  assert.deepEqual(h.runner.calls[0], { argv: ["bd", "--actor", "sona", "list", "--type", "phase", "--limit", "0", "--json"], ...CONNECTION(h.home) });
  assert.deepEqual(
    h.runner.calls.slice(1).map((call) => call.argv),
    BEADS.map((bead) => ["bd", "--actor", "sona", "show", bead.id, "--json"]),
  );
});

test("the Mermaid graph names every edge and marks the pass, the entry phases with their classes, the per: fan-out and the cross-recipe edge", async (t) => {
  const h = host(t, TABLE);

  await h.run();

  const graph = lines(h.out);
  const start = graph.indexOf("```mermaid");
  const end = graph.indexOf("```", start + 1);
  assert.ok(start >= 0 && end > start, "a fenced mermaid block");
  const mermaid = graph.slice(start + 1, end);
  assert.equal(mermaid[0], "flowchart LR");
  assert.ok(mermaid.includes('  subgraph umka ["umka rev:a1b2c3d"]'), "one subgraph per recipe, titled with its revision");
  assert.ok(mermaid.includes('  subgraph triage ["triage rev:9f8e7d6"]'));
  assert.ok(mermaid.includes('    umka__explore["explore<br/>entry: question, idea"]:::entry'), "the entry phase carries its classes");
  assert.ok(mermaid.includes('    triage__review["review<br/>entry: ticket"]:::entry'));
  assert.ok(mermaid.includes('    umka__approve_proposal{{"approve-proposal"}}:::pass'), "the pass phase is marked");
  assert.ok(mermaid.includes('    umka__research["research"]'));
  const edges = mermaid.filter((line) => /-->|==>|-\.->/.test(line));
  // Phases in recipe then slug order, each phase's edges as its `to` lists them.
  assert.deepEqual(edges, [
    "  umka__approve_proposal --> umka__spec",
    '  umka__explore -->|"the question needs a source read"| umka__research',
    "  umka__explore --> umka__approve_proposal",
    '  umka__research -->|"the #quot;source#quot; is read"| umka__explore',
    '  umka__slice -.->|"per module, the slice touches a shared module"| triage__review',
    '  umka__spec ==>|"per ticket"| umka__slice',
  ]);
  assert.ok(!mermaid.some((line) => line.includes("sort")), "a superseded revision is not drawn");
  assert.ok(mermaid.some((line) => line.startsWith("  classDef pass ")));
  assert.ok(mermaid.some((line) => line.startsWith("  classDef entry ")));
});

test("the derived paths start at each entry phase, mark passes and fan-outs, cross recipes and stop on a cycle", async (t) => {
  const h = host(t, TABLE);

  await h.run();

  const text = h.out.join("");
  const paths = text.slice(text.indexOf("## Paths"));
  assert.deepEqual(paths.split("\n").filter((line) => line.startsWith("- ") || line.startsWith("### ")), [
    "### From triage/review, the entry for ticket: 1 path",
    "- review",
    "### From umka/explore, the entry for question, idea: 2 paths",
    "- explore → research → ↺ explore",
    "- explore → approve-proposal (pass) → spec → per ticket → slice → per module → triage/review",
  ]);
});

test("an edge to a phase the space does not hold is reported on stderr and left out of the graph", async (t) => {
  const lost = { id: "kitchen-31", title: "umka/lost", labels: ["rev:a1b2c3d"], text: RESEARCH.replace("phase: research", "phase: lost").replace("phase: explore", "phase: nowhere") };
  const h = host(t, [
    { command: "bd", args: ["--actor", "sona", "list"], stdout: JSON.stringify([listed(lost)]) },
    { command: "bd", args: ["--actor", "sona", "show", lost.id], stdout: JSON.stringify([{ ...listed(lost), description: lost.text }]) },
  ]);

  const code = await h.run();

  assert.equal(code, 0);
  assert.equal(h.err.join(""), 'phase-graph: umka/lost leads to "nowhere", which is not a registered phase; the edge is not drawn\n');
  assert.ok(lines(h.out).includes('    umka__lost["lost"]'));
  assert.ok(!h.out.join("").includes("nowhere"));
});

test("the same space listed in another order gives the same text", async (t) => {
  const first = host(t, TABLE);
  const shuffled: ScriptedAnswer = { command: "bd", args: ["--actor", "sona", "list"], stdout: JSON.stringify([...BEADS].reverse().map(listed)) };
  const second = host(t, [shuffled, ...TABLE.slice(1)]);

  await first.run();
  await second.run();

  assert.equal(second.out.join(""), first.out.join(""));
});

test("without a host config the script explains and exits 1 without a bd call", async (t) => {
  const h = host(t, TABLE, false);

  const code = await h.run();

  assert.equal(code, 1);
  assert.match(h.err.join(""), /no host config: run kitchen init first/);
  assert.equal(h.runner.calls.length, 0);
});
