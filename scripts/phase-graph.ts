#!/usr/bin/env node
// The design illustration drawn from the space (story 24): the registered phases of the latest
// revision of every recipe as a Mermaid graph, then the paths a reader can derive from each entry
// phase. Not a CLI command (the CLI has its ten commands and nothing else); run it from a clone with
//
//     node scripts/phase-graph.ts > docs/phase-graph.md
//
// Reads go through the space wrapper under the owner's actor: one bd list, then one bd show per
// phase bead of a latest revision. The latest revision is, as kitchen recipe add leaves it, every
// phase bead of the recipe not labelled superseded.
import { pathToFileURL } from "node:url";
import { resolveActor } from "../src/actor.ts";
import { readHostConfig } from "../src/config.ts";
import type { RegisteredPhase } from "../src/recipe/lint.ts";
import { SUPERSEDED } from "../src/registered.ts";
import { isPass, parsePhaseFile, PhaseError, phaseTitle, splitTitle } from "../src/recipe/phase.ts";
import type { Edge } from "../src/recipe/phase.ts";
import type { CommandRunner } from "../src/runner.ts";
import { openSpace } from "../src/space.ts";

export interface GraphDeps {
  runner: CommandRunner;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** One `to` entry resolved to the registered phase it names. */
interface ResolvedEdge {
  from: RegisteredPhase;
  to: RegisteredPhase;
  edge: Edge;
}

/** The revision label of each recipe's latest revision. */
type Revisions = ReadonlyMap<string, string>;


/** Draws the graph to stdout; exit code 0, or 1 with the reason on stderr. */
export async function phaseGraph(deps: GraphDeps): Promise<number> {
  const config = readHostConfig(deps.env);
  if (!config) {
    deps.stderr("phase-graph: no host config: run kitchen init first\n");
    return 1;
  }
  const warn = (text: string): void => deps.stderr(`phase-graph: ${text}\n`);
  const space = openSpace({ runner: deps.runner, env: deps.env, config, actor: resolveActor(deps.env, config) });

  const latest = (await space.list({ type: "phase" })).filter((bead) => !bead.labels?.includes(SUPERSEDED));
  const phases: RegisteredPhase[] = [];
  const revisions = new Map<string, string>();
  for (const listed of latest) {
    const title = splitTitle(listed.title);
    if (!title) continue;
    const bead = await space.show(listed.id);
    try {
      phases.push({ recipe: title.recipe, phase: parsePhaseFile(bead.description ?? "", `${title.slug}.md`) });
    } catch (error) {
      if (!(error instanceof PhaseError)) throw error;
      warn(`${listed.title} (${listed.id}) skipped: ${error.message}`);
      continue;
    }
    const revision = bead.labels?.find((label) => label.startsWith("rev:")) ?? "rev:?";
    const known = revisions.get(title.recipe);
    if (known === undefined) revisions.set(title.recipe, revision);
    else if (known !== revision) warn(`${title.recipe} has two revisions without a superseded label: ${known} and ${revision}`);
  }
  phases.sort((a, b) => a.recipe.localeCompare(b.recipe) || a.phase.slug.localeCompare(b.phase.slug));

  const edges = resolveEdges(phases, warn);
  deps.stdout(render(phases, revisions, edges));
  return 0;
}

/**
 * Every `to` entry of every phase, in phase order then declaration order, bound to its target. A
 * name resolves as the lint resolves it: `<recipe>/<slug>` exactly, a bare slug in its own recipe
 * first and then in another's. A name that resolves nowhere is reported and left out.
 */
function resolveEdges(phases: readonly RegisteredPhase[], warn: (text: string) => void): ResolvedEdge[] {
  const byTitle = new Map(phases.map((p) => [phaseTitle(p.recipe, p.phase.slug), p]));
  const locate = (from: RegisteredPhase, name: string): RegisteredPhase | undefined => {
    if (name.includes("/")) return byTitle.get(name);
    return byTitle.get(phaseTitle(from.recipe, name)) ?? phases.find((p) => p.recipe !== from.recipe && p.phase.slug === name);
  };
  const edges: ResolvedEdge[] = [];
  for (const from of phases) {
    for (const edge of from.phase.to) {
      const to = locate(from, edge.phase);
      if (to) edges.push({ from, to, edge });
      else warn(`${phaseTitle(from.recipe, from.phase.slug)} leads to "${edge.phase}", which is not a registered phase; the edge is not drawn`);
    }
  }
  return edges;
}

function render(phases: readonly RegisteredPhase[], revisions: Revisions, edges: readonly ResolvedEdge[]): string {
  const recipes = [...new Set(phases.map((p) => p.recipe))];
  const lines = [
    "# Registered phases",
    "",
    "Drawn from the space by `node scripts/phase-graph.ts`; edit nothing here by hand. One subgraph per recipe at its latest revision. " +
      "A hexagon is a pass phase. An entry phase lists the classes it starts. An edge labelled `per <item>` is a fan-out, one child per item, " +
      "drawn thick inside a recipe. A dotted edge crosses into another recipe. The rest of an edge label is the prose `when` the laying turn judges.",
    "",
    `Recipes: ${recipes.map((recipe) => `${recipe} ${revisions.get(recipe)}`).join(", ") || "none"}.`,
    "",
    "```mermaid",
    "flowchart LR",
  ];
  for (const recipe of recipes) {
    lines.push(`  subgraph ${mermaidId(recipe)} ["${recipe} ${revisions.get(recipe)}"]`);
    for (const p of phases.filter((p) => p.recipe === recipe)) lines.push(...node(p).map((line) => `    ${line}`));
    lines.push("  end");
  }
  for (const e of edges) lines.push(`  ${nodeId(e.from)} ${arrow(e)} ${nodeId(e.to)}`);
  lines.push("  classDef pass fill:#fff4d6,stroke:#b8860b");
  lines.push("  classDef entry stroke-width:3px");
  lines.push("```", "", "## Paths", "");
  lines.push("From each entry phase, every path a reader can derive by following the edges in the order they are written. A path ends at a phase nothing follows, or where it returns to a phase already walked (↺).", "");
  for (const entry of phases.filter(isEntry)) {
    const paths = pathsFrom(entry, edges);
    lines.push(`### From ${phaseTitle(entry.recipe, entry.phase.slug)}, the entry for ${entry.phase.entry.join(", ")}: ${paths.length} path${paths.length === 1 ? "" : "s"}`, "");
    for (const path of paths) lines.push(`- ${path}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const isEntry = (p: RegisteredPhase): boolean => p.phase.entry.length > 0;
const mermaidId = (name: string): string => name.replace(/[^A-Za-z0-9]/g, "_");
const nodeId = (p: RegisteredPhase): string => `${mermaidId(p.recipe)}__${mermaidId(p.phase.slug)}`;
const quoted = (text: string): string => `"${text.replace(/"/g, "#quot;")}"`;

/** The node's lines: its shape and label, and the entry class on a pass that is also an entry. */
function node(p: RegisteredPhase): string[] {
  const label = isEntry(p) ? `${p.phase.slug}<br/>entry: ${p.phase.entry.join(", ")}` : p.phase.slug;
  if (!isPass(p.phase)) return [`${nodeId(p)}[${quoted(label)}]${isEntry(p) ? ":::entry" : ""}`];
  const lines = [`${nodeId(p)}{{${quoted(label)}}}:::pass`];
  if (isEntry(p)) lines.push(`class ${nodeId(p)} entry`);
  return lines;
}

function arrow({ from, to, edge }: ResolvedEdge): string {
  const shaft = from.recipe !== to.recipe ? "-.->" : edge.per !== undefined ? "==>" : "-->";
  const label = [edge.per !== undefined ? `per ${edge.per}` : undefined, edge.when].filter((part) => part !== undefined).join(", ");
  return label ? `${shaft}|${quoted(label)}|` : shaft;
}

/** Depth-first in edge order; a step onto a phase already on the path ends it there. */
function pathsFrom(entry: RegisteredPhase, edges: readonly ResolvedEdge[]): string[] {
  const paths: string[] = [];
  /** A phase as the path names it: its slug within the entry's recipe, `<recipe>/<slug>` outside it. */
  const name = (p: RegisteredPhase): string => {
    const title = p.recipe === entry.recipe ? p.phase.slug : phaseTitle(p.recipe, p.phase.slug);
    return isPass(p.phase) ? `${title} (pass)` : title;
  };
  const walk = (at: RegisteredPhase, walked: readonly RegisteredPhase[], text: string): void => {
    const outs = edges.filter((e) => e.from === at);
    if (!outs.length) {
      paths.push(text);
      return;
    }
    for (const { to, edge } of outs) {
      const hop = edge.per !== undefined ? `→ per ${edge.per} →` : "→";
      if (walked.includes(to)) paths.push(`${text} ${hop} ↺ ${name(to)}`);
      else walk(to, [...walked, to], `${text} ${hop} ${name(to)}`);
    }
  };
  walk(entry, [entry], name(entry));
  return paths;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { processRunner } = await import("../src/runner.ts");
  process.exitCode = await phaseGraph({
    runner: processRunner,
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
