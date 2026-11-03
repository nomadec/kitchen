---
status: accepted
---

# Recipes are phase bundles registered into the space, not beads formulas

Beads has a workflow layer: a formula defines steps and dependencies, is cooked into a proto in the database, and is poured into a molecule of real beads. It looked like the natural home for a recipe. It is not. Umka's recipe has 28 phases and 55 edges, and 30 of those edges carry a prose condition that the agent finishing a phase judges in the moment: "the move is research", "the PR has open threads", "the failure is a design question". A formula is a static graph with compile-time conditions, so it cannot hold that recipe, and neither can any other pre-laid plan.

Kitchen therefore registers phases, not plans. A phase is a bead of type `phase` whose body is the phase file: skill, needs, budget, artifact, the `from` and `to` edges with their conditions, and the run, reconcile and close-out sections. A recipe is the bundle of phases one plugin registers in one act. The space holds one phase graph, and an edge may name a phase from another bundle, which is how an order crosses from the bug path to the design path. Nothing recipe-shaped is committed to the Kitchen repository; a bundle arrives from a plugin directory, a file or a URL at registration time.

The turn that finishes a phase judges its `to` rules and lays the next phase beads, including the per-item fan-out. Beads gates still carry the waits: a pass is a human gate, and PR-merged, CI-green and time-box waits are typed gates evaluated by the expeditor.

One exception: a test fixture. `scripts/smoke-fixture/` is a three-phase recipe (`greet`, the pass `approve`, `confirm`) committed so that the hand-run smoke (`scripts/smoke.ts`) can register a recipe, run a turn and answer a pass on a host where no real recipe is installed. It is registered by the smoke into the smoke's own throwaway database, never into a team space, and it is not shipped: `package.json` lists `dist` and `plugin` as the published files. Kitchen still holds no recipe of its own.

## Consequences

- Umka's `run` skill loses its content and becomes Kitchen's turn driver; its phase files become the first registered bundle.
- Beads formulas and molecules stay unused. They are listed in the README primitives as known and not exposed.
- Prior art: Gas City's typed gate beads, kept as a reference for the pass and the typed waits.

## Considered options

- Recipe as a beads formula: rejected, because a static graph cannot express agent-judged routing.
- Recipe as a file in the Kitchen repository: rejected, because registration must be on demand and Kitchen holds no recipe of its own.
