---
phase: approve
skill: human
from: [greet]
to:
  - phase: confirm
artifact: the person's word on the greeting
ask: whether the greeting may be confirmed, with go as the recommended answer and any other word recorded as it is
---
# approve

A pass: a person reads the greeting and answers with a word. The turn behind this pass applies the word in its reconcile step.

**Apply:** the word is the pass's close reason. Put it on the order:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/lay.mjs" note <order> answer "<word>"
```

Every word continues to `confirm`; no word redirects the order.
