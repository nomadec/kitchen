# Kitchen v1: spec review QA checklist

Source: [Kitchen v1 specification, issue #1](https://github.com/nomadec/kitchen/issues/1).
Review captured: 2026-11-03.

## Purpose and interpretation

The architecture is coherent and aligned with the working-tree glossary and ADRs reviewed on this date. The initial review overstated the implementation-blocking nature of several findings. Most are engineering decisions an implementing agent can resolve while meeting the spec's outcomes; they do not require a prescribed implementation or prior user approval.

Use this checklist to verify those outcomes during QA. It is not a replacement specification. Alternative implementations pass when they satisfy the observable behavior. Four areas need a clear, recorded interpretation: recipe revisions, the human-only trust boundary, attended interaction, and the permitted scope of Umka migration. Resolve these from the latest specification or record the decision before judging the relevant check.

The review inspected the issue and its clarification comment, repository docs, the local Umka driver and phase files, and help output from installed `bd 1.3.1`. It did not run Kitchen end to end. All checks below start untested; an unchecked box is not evidence of a defect.

## Running and recording QA

Use an isolated test space and disposable repositories. Record the Kitchen revision, beads and Claude Code versions, recipe revision, hosts and stations used, and relevant bead IDs. For each check record PASS, FAIL, BLOCKED, or NOT RUN, with evidence and any follow-up issue. Check a box only after its outcome has been demonstrated. Do not record credentials or token contents.

Repeat concurrency checks with overlapping operations, not just sequential runs. Use controlled faults or a suitable test harness where needed. Supplement fake-command tests with real integration evidence for claims, recovery, human interaction, and host handoffs.

## 1. First-turn startup

**Original concern:** intake creates an order, but assignment is described as the responsibility of an existing turn. Umka's removed pick step previously selected the initial phase.

**Classification:** implementation responsibility; the entry behavior must satisfy the recipe without adding a fixed Kitchen workflow.

- [ ] Add an order manually with an explicit recipe. It reaches the appropriate first phase and an eligible station without manually creating or assigning a phase bead.
- [ ] Ingest an item through a registered source. It reaches the same usable starting state.
- [ ] When no station qualifies, a human receives an actionable pass; the order does not silently stall.
- [ ] Different supported input classes enter the recipe as intended, with the selection explainable from the recipe and recorded context.

## 2. Claims, heartbeats, and recovery preserve assignment

**Original concern:** phases are assigned to a station, the expeditor writes under its own actor, and the driver checks its claim. Installed `bd` help says a claim sets the assignee to the claimant, only the holder may heartbeat, and reclaim clears the assignee.

**Classification:** implementation responsibility. QA does not require a particular representation of assignment or claim ownership.

- [ ] A phase assigned to a station starts successfully, passes the driver's ownership check, and stays leased while its session is alive.
- [ ] Competing dispatch attempts do not run the same phase twice.
- [ ] After a killed child or expeditor restart, stale work becomes recoverable and returns to an eligible station without manual assignee repair.
- [ ] Audit records distinguish human, turn, and expeditor actions consistently with the documented identity model.
- [ ] A second failed attempt produces the required pass and prevents an automatic third attempt until the human resolution permits it.

## 3. Attended turns support actual conversation

**Original concern:** attended phases need a human in the session, but the runner is described as headless even for foreground turns. Umka's grill phase requires a conversation.

**Classification:** clarify the constraint. The spec should permit an interaction mechanism; the implementing agent chooses how it works.

- [ ] Record how attended interaction is supported and how it fits the runner contract.
- [ ] An attended station never automatically starts a waiting phase.
- [ ] Start a waiting grill through `kitchen turn`. The human can receive questions, provide multiple replies, and explicitly proceed; those replies affect the resulting proposal.
- [ ] Exercise the UI start action promised by story 43 and verify how the user reaches the interaction.
- [ ] Starting an attended turn is not treated as approval of later human decisions.

## 4. Human answers resume the correct work

**Original concern:** the spec promises Umka's answer-application semantics but does not name the step that interprets closed passes. Umka explicitly handles closed, unapplied items and their Apply sections.

**Classification:** implementation responsibility; preserve recipe semantics without prescribing a tick implementation.

- [ ] Reach a pass with a brief, answer through the CLI, and observe the correct continuation on a subsequent tick.
- [ ] Repeat through the UI, including an answer that changes the continuation rather than merely approving it.
- [ ] Where the recipe requires applying an answer, its effects are applied once; repeated ticks or a restart do not duplicate downstream work.
- [ ] Resolve passes caused by a missing eligible station, a rounds cap, and repeated failure. Each resolution either resumes the intended work or leaves an explicit, understandable reason for waiting.
- [ ] Closing a pass does not automatically launch a continuation that still requires an attended station to be started by a human.

## 5. Coordination holds across hosts and processes

**Original concern:** process-local mutexes cannot alone enforce the per-order limit across expeditors and foreground commands. Every host owned by one person is also instructed to poll that person's sources.

**Classification:** implementation responsibility; shared coordination and idempotency mechanisms are implementation choices.

- [ ] Make two children of one order ready on different hosts and dispatch concurrently. At most one turn for that order runs at a time.
- [ ] Race a foreground `kitchen turn` with other dispatch activity. Per-order and per-station limits still hold.
- [ ] Different orders can run concurrently up to the relevant station caps.
- [ ] Have two hosts poll the same source concurrently. Each new source item creates one order, and the cursor does not skip items.
- [ ] Interrupt intake between order creation and cursor advancement, then retry. No item is lost or duplicated.

## 6. Station handoffs preserve repository state

**Original concern:** worktrees are station-local, while successive phases can move to another station or host. Reusing a branch name alone does not transfer its commits.

**Classification:** implementation responsibility; publication, fetching, checkout, and cleanup details are unconstrained.

- [ ] Make a code change in one station, then assign the next phase to another host. It sees the intended order commits and continues on the correct branch.
- [ ] Repeat with an order spanning multiple repositories. Each repository resumes at the correct state.
- [ ] Two orders at one station keep their changes isolated, and the main checkouts remain clean.
- [ ] Closing an order removes its Kitchen-managed worktrees across participating hosts, with eventual cleanup verified if a host was offline.

## 7. Human-only actions match the declared trust boundary

**Original concern:** humans and stations share SQL credentials, while actor names are caller-asserted. Installed `bd serve` help explicitly describes actors as provenance, not authenticated identity. A wrapper alone does not establish isolation from an unrestricted agent.

**Classification:** clarify the promised outcome: cooperative workflow restrictions or an enforced security boundary.

- [ ] Record which trust model is intended and ensure the specification's guarantees match it.
- [ ] Through supported station interfaces, attempts to register or edit recipes, stations, or sources are refused.
- [ ] Through supported station interfaces, attempts to close human passes are refused; authorized human answers succeed.
- [ ] If an enforced boundary is promised, verify that a station cannot bypass it through direct `bd`, HTTP, database access, or a forged human actor using the access available to that station.
- [ ] If cooperative restrictions are intended, document their limits and avoid claiming that an unrestricted station is technically unable to impersonate a human.

## 8. Recipe updates have one consistent meaning

**Original concern:** story 18 and Out of Scope promise changes affect new orders only, while registration explicitly preserves only already-laid phases. Future phases in an existing order could therefore use changed definitions.

**Classification:** clarify the intended semantics; order-pinned revisions and phase-at-a-time updates are different outcomes.

- [ ] Record the chosen policy and reconcile the relevant spec sections.
- [ ] Start an order, replace its recipe with a visibly changed definition, then advance the original order. Its future phases follow the chosen policy.
- [ ] Already-laid phases retain their captured text and resolved model.
- [ ] New orders use the replacement recipe, with enough revision evidence to explain which definitions each tested order used.

## 9. Umka migration preserves behavior under the new runtime

**Original concern:** limiting changes to frontmatter conflicts with phase bodies that still reference `/umka:run`, checkpoints, and old close-out behavior. Existing budgets include token-like values such as `30k`, while Kitchen specifies dollar caps and effort. The existing merge phase lacks Kitchen's new verification procedure.

**Classification:** clarify permitted compatibility changes. Preserve workflow semantics while allowing the body and budget edits needed for the new runtime.

- [ ] Record the allowed migration scope and the budget schema, units, and mapping to runner settings.
- [ ] Register the migrated Umka bundle successfully with the required graph validation.
- [ ] Active phase instructions use working Kitchen entry points and do not depend on removed run, queue, pick, or registry scripts.
- [ ] Check representative unattended, attended, pass, loop, and fan-out flows for preserved recipe behavior.
- [ ] Configured budgets produce the intended runtime limits; old values are deliberately migrated or rejected, never silently reinterpreted as dollars.
- [ ] Umka's merge and close-out behavior meets Kitchen's verification, result-line, and cleanup requirements.

## 10. Merge verifies the revision that will be merged

**Original concern:** fetching the base branch does not itself update the order's worktree or demonstrate that verification passed against the current base.

**Classification:** implementation responsibility; the agent may choose the branch-update and merge strategy.

- [ ] Advance the base branch after the order's branch is created. The merge flow incorporates or otherwise verifies compatibility with that base before proceeding.
- [ ] Run every configured repository verification command in order and record the results on the phase bead.
- [ ] A failing verification command prevents merging.
- [ ] If the base or proposed merge content changes after verification, stale success is not accepted as proof for different content.
- [ ] Evidence identifies the tested revision and base and connects them to the content ultimately merged.

## Minimum integration coverage

The original smoke stops too early to demonstrate several of these outcomes. Preserve its isolated-space setup and cover these additional journeys in QA:

- [ ] Register recipe and station, add an order, reach a briefed pass, answer as a human, and observe the correct continuation.
- [ ] Hand work from one station to another and verify repository continuity.
- [ ] Interrupt a turn, recover it, and exercise the second-failure pass.
- [ ] Race dispatch across hosts to demonstrate the per-order limit.

## Run record

Copy this section for each QA run. Link detailed evidence or follow-up issues where needed.

- Date:
- Kitchen revision:
- Recipe revision:
- Tool versions:
- Test space, repositories, hosts, and stations:
- Recorded spec interpretations:

| Check | Result | Evidence / bead IDs / follow-up |
| --- | --- | --- |
| 1. First-turn startup | NOT RUN | |
| 2. Claims and recovery | NOT RUN | |
| 3. Attended interaction | NOT RUN | |
| 4. Human-answer continuation | NOT RUN | |
| 5. Cross-host coordination | NOT RUN | |
| 6. Station handoffs | NOT RUN | |
| 7. Human-only trust boundary | NOT RUN | |
| 8. Recipe update semantics | NOT RUN | |
| 9. Umka migration | NOT RUN | |
| 10. Merge verification | NOT RUN | |
| Minimum integration coverage | NOT RUN | |
