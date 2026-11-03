---
phase: confirm
skill: smoke:confirm
model: claude-sonnet-5
rounds: 1
from: [approve]
to: []
artifact: a confirmed line in the order's notes and the order closed with its result line
budget:
  usd: 1
  effort: low
---
# confirm

The phase behind the pass. It runs once the person has answered, and the answer is applied before this work starts.

**Input:** the order's `greeting:` and `answer:` note lines.

**Run:** the skill `smoke:confirm` is this section; no plugin provides it. Read the order's notes: `answer:` is the person's word, applied in reconcile. Put the confirmation on the order:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/lay.mjs" note <order> confirmed "<the word>, on: <the greeting>"
```

**Done when:** the order's notes carry a `confirmed:` line.

**Reconcile:** a `confirmed:` line already on the order is the artifact: skip the work.

**Close out:** nothing follows this phase, and the order names no repository, so there is no branch to push and none to delete. Close this phase with the `confirmed:` line as its reason, then close the order with `node "${CLAUDE_PLUGIN_ROOT}/bin/lay.mjs" close <order> --reason "Order done: smoke, no pull request"` and print `Order done: smoke, no pull request` as the result line.
