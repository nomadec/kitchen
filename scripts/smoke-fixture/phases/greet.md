---
phase: greet
skill: smoke:greet
model: claude-sonnet-5
entry: [idea]
rounds: 1
from: []
to:
  - phase: approve
artifact: a greeting line in the order's notes
budget:
  usd: 1
  effort: low
---
# greet

The entry phase of the smoke recipe. Nothing is checked out and no tracker is involved: the whole phase is one note on the order.

**Input:** the order's description, the sentence the smoke added the order with.

**Run:** the skill `smoke:greet` is this section; no plugin provides it, so do not look for one. Write one greeting sentence that quotes the order's description, then put it on the order:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/lay.mjs" note <order> greeting "<the sentence>"
```

**Done when:** `bd show <order> --json` shows a `greeting:` line in the order's notes.

**Reconcile:** a `greeting:` line already on the order is the artifact: skip the work.

**Close out:** the order names no repository, so there is no branch to commit or push. The one `to` entry is the pass `approve`. A person is needed, so lay the phase behind the pass (`confirm`) first and the pass in front of it, as the turn driver's close-out says. The brief asks whether the greeting may be confirmed; the recommended answer is `go`. Then close this phase with the greeting line as its reason.
