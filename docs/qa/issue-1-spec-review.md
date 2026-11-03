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

## Run record: the smoke, 2026-11-03

The hand-run smoke, `node scripts/smoke.ts` (README, The smoke), on the development host, twice: once against the real `claude`, which is not signed in on this host, and once with the stand-in `claude` shipped under `scripts/smoke-standin` first on the path, a shell script that does what the `kitchen:turn` skill asks for the fixture's two worked phases, through the lay helper under the station actor. The second run proves the harness (every `bd` write and read, the expeditor, `kitchen pass`, the answer applied once) and nothing about the turn driver's prose; the first is the release gate and stays BLOCKED until a signed-in `claude` runs it.

- Date: 2026-11-03
- Kitchen revision: `9dc3b67` (this slice's first commit on `altcode/ALT-160`, as the smoke's header printed) with the review changes in the working tree at run time; the final commit is recorded on the slice's task
- Recipe revision: the smoke fixture `scripts/smoke-fixture`, `smoke rev:5dcf53d` (three phases: `greet`, the pass `approve`, `confirm`); the migrated Umka plugin was not available (story 79 lives in nomadec/marketplace)
- Tool versions: bd 1.3.1 (c1c4b642a), claude 2.1.316 (Claude Code), Node v24.21.0, Dolt 2.6.2 as a throwaway `dolt sql-server` on 127.0.0.1:3399
- Test space, repositories, hosts, and stations: one database per run on that server (`kitchen_smoke_20261103_083810` real claude; `kitchen_smoke_20261103_083833` stand-in), no repository (the fixture's station offers none, so the order touches no code), host `bos-umid-kushayev-paperclip-rbn3`, owner `smoke`, one unattended station `smoke/smoke` (cap 1, timeout 10m)
- Recorded spec interpretations: "assigned by a turn" is read from the beads: the pass and the phase behind it carry the station title as `created_by` and the phase an `assigned:` note. "Applies the answer once" is read as the pass labelled `applied`, one `answer:` line on the order, one turn on the phase behind in the expeditor log, and a further tick starting nothing. A check the host cannot run (no `claude` login) is BLOCKED, not FAIL.

Two defects the real `bd` surfaced, both fixed in this slice with a fake-runner test each: `bd init` ignores the credentials file and takes the password from `BEADS_DOLT_PASSWORD` only, so `kitchen init` could not reach any server with a password (it now reads the `[host:port]` section and passes the password to that one call); and the take's release at the end of a turn (`--status open`) reopened an order the turn had just closed with `Order done:` (the release is now skipped when the order is closed). Also noted: `bd list` hides gates unless asked for `--type gate` (or `--include-gates`), which Kitchen's own reads already do.

Real `claude` (database `kitchen_smoke_20261103_083810`): checks 1 to 4 PASS (phase beads kitchen-1yh, kitchen-eqx, kitchen-tyg; station kitchen-jgt; order kitchen-a3g; entry phase kitchen-a3g.1 assigned `entry: mechanical`); check 5 BLOCKED: both turns exited 1 with `Not logged in · Please run /login`, the second failure laid the `turn failed: greet` pass kitchen-4f4 for the owner and no third turn started; checks 6 to 9 not reached.

Stand-in `claude` (database `kitchen_smoke_20261103_083833`): all nine checks PASS. Phase beads kitchen-20s, kitchen-90e, kitchen-di9; station kitchen-cv7; order kitchen-pou; entry kitchen-pou.1 closed by the first turn; pass kitchen-c1w (`approve`, created by `smoke/smoke`, brief present) blocking kitchen-pou.2 (`confirm`, created and assigned by the turn with an `assigned:` note); `kitchen pass kitchen-c1w go` under `BEADS_ACTOR=smoke/smoke` refused with exit 1 naming the cooperative rule, the pass still open; the same under the owner closed it with `go`; the next tick ran kitchen-pou.2 once, the pass labelled `applied`, one `answer: go` line, a further tick started nothing; the order closed with `Order done: smoke, no pull request`.

| Check | Result | Evidence / bead IDs / follow-up |
| --- | --- | --- |
| 1. First-turn startup | PASS (first box) | An order added by hand with an explicit recipe reached its entry phase, assigned to the one eligible station without a phase laid by hand: kitchen-a3g.1 and kitchen-pou.1 (`entry: mechanical`). The other boxes (a registered source, no qualifying station, other classes) NOT RUN |
| 2. Claims and recovery | PASS (first and last box), others NOT RUN | The take and the claim under the station actor, the lease held while the child lived (expeditor log, both runs); the second failed turn laid `turn failed: greet` kitchen-4f4 and no third turn started (real-claude run). Kill, restart and competing dispatch NOT RUN |
| 3. Attended interaction | NOT RUN | The smoke's station is unattended by design |
| 4. Human-answer continuation | PASS with the stand-in; BLOCKED with the real `claude` | Pass kitchen-c1w answered through the CLI, the continuation kitchen-pou.2 ran on the next tick and applied the word once (label `applied`, one `answer:` line, one turn, a further tick idle). The UI path, a redirecting answer and the Kitchen-laid passes (rounds cap, no station) NOT RUN |
| 5. Cross-host coordination | NOT RUN | One host |
| 6. Station handoffs | NOT RUN | The order names no repository |
| 7. Human-only trust boundary | PASS (third box) | `kitchen pass` under the station actor refused before any `bd` call, naming the cooperative rule and `docs/trust-model.md`; the owner's close succeeded. Registration under a station actor, and the limit statement, are covered by unit tests and `docs/trust-model.md`; not re-run by hand |
| 8. Recipe update semantics | NOT RUN | One revision registered |
| 9. Umka migration | BLOCKED | The migrated plugin is not on this host; the smoke takes any plugin directory (`--plugin`) and will run against it as it is |
| 10. Merge verification | NOT RUN | No code, no pull request |
| Minimum integration coverage | PASS (first journey) with the stand-in; BLOCKED with the real `claude` | Register recipe and station, add an order, reach a briefed pass, answer as a human, observe the continuation: the smoke's checks 2 to 8. The other three journeys NOT RUN |

Unblock: sign `claude` in on the host (`claude /login`, or an `ANTHROPIC_API_KEY` the CLI accepts) and run `node scripts/smoke.ts` again; the run record is complete when the real-`claude` row of checks 5 to 9 reads PASS.
