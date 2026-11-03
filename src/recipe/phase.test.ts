// The parsed phase shape the package exports for intake, the expeditor and the graph: frontmatter
// with Umka's keys plus Kitchen's, and the body, read back from a phase file or a phase bead's description.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPass, parsePhaseFile } from "../index.ts";

const REVIEW = `---
phase: review
skill: mattpocock-skills:code-review
model: claude-opus-5
needs: the repository checked out
rounds: 3
from: [pr, address]
to:
  - phase: decide-blocking
  - phase: implement
    when: the slicing laid tickets
    per: ticket
artifact: a review verdict on the PR
budget:
  usd: 5.5
  effort: high
---
# review

**Run:** review the PR.
`;

test("a phase file parses into its frontmatter keys and its body", () => {
  const phase = parsePhaseFile(REVIEW, "review.md");
  assert.deepEqual(phase, {
    slug: "review",
    file: "review.md",
    text: REVIEW,
    body: "# review\n\n**Run:** review the PR.\n",
    phase: "review",
    skill: "mattpocock-skills:code-review",
    model: "claude-opus-5",
    needs: "the repository checked out",
    rounds: 3,
    from: ["pr", "address"],
    to: [{ phase: "decide-blocking" }, { phase: "implement", when: "the slicing laid tickets", per: "ticket" }],
    artifact: "a review verdict on the PR",
    entry: [],
    budget: { usd: 5.5, effort: "high" },
  });
  assert.equal(isPass(phase), false);
});

test("a pass phase is one with skill human, carrying ask and skip when", () => {
  const phase = parsePhaseFile(
    "---\nphase: approve-spec\nskill: human\nfrom: [spec]\nto:\n  - phase: slice\nartifact: the pass is closed\nask: the spec URL\nskip when: the spec changes no story\n---\n",
    "phases/approve-spec.md",
  );
  assert.equal(isPass(phase), true);
  assert.equal(phase.ask, "the spec URL");
  assert.equal(phase.skipWhen, "the spec changes no story");
  assert.equal(phase.body, "");
});

test("a malformed file names the rule in the error", () => {
  assert.throws(() => parsePhaseFile("# no frontmatter\n", "sort.md"), (error: Error) => {
    assert.equal(error.name, "PhaseError");
    assert.match(error.message, /^sort\.md: frontmatter: no frontmatter block/);
    return true;
  });
  assert.throws(() => parsePhaseFile("---\nphase: grill\nskill: x\nfrom: []\nto: []\nartifact: a\nmodel: m\nbudget:\n  usd: 1\n  effort: low\n---\n", "sort.md"), /sort\.md: phase: "grill" differs from the file name "sort"/);
});
