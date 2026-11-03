// The bundle lint: the rules a recipe must hold against itself and against the latest revision
// of every other recipe in the space, so the graph is always walkable (spec story 15).
import { parsePhaseFile, PhaseError, phaseTitle, slugOf } from "./phase.ts";
import type { Phase } from "./phase.ts";
import type { PhaseFile } from "./bundle.ts";

/** One failed rule, naming the phase it failed on. */
export interface Finding {
  /** `<recipe>/<slug>`. */
  phase: string;
  rule: string;
  message: string;
}

/** A phase registered in the space, as another recipe's latest revision holds it. */
export interface RegisteredPhase {
  recipe: string;
  phase: Phase;
}

export const describeFinding = (finding: Finding): string => `${finding.phase}: ${finding.rule}: ${finding.message}`;

/** Where an edge's name lands: a phase of this bundle, of one other recipe, of several, or nowhere. */
type Location = "own" | "registered" | "ambiguous" | undefined;

/**
 * Lints a bundle. Every file is parsed; the graph rules run over the phases that parsed, and
 * edges may name a phase of another recipe by its slug or as `<recipe>/<slug>`. Symmetry of
 * `from` and `to` binds within the bundle: a registered recipe cannot list a phase it never knew.
 */
export function lintBundle(recipe: string, files: readonly PhaseFile[], registered: readonly RegisteredPhase[]): Finding[] {
  const findings: Finding[] = [];
  const phases: Phase[] = [];

  for (const { file, text } of files) {
    try {
      phases.push(parsePhaseFile(text, file));
    } catch (error) {
      if (!(error instanceof PhaseError)) throw error;
      findings.push({ phase: phaseTitle(recipe, slugOf(file)), rule: error.rule, message: error.message.slice(`${file}: ${error.rule}: `.length) });
    }
  }

  const own = new Map(phases.map((phase) => [phase.slug, phase]));
  const others = registered.filter((r) => r.recipe !== recipe);
  /** A name as this bundle's phases know it: `<recipe>/<slug>` of this recipe is its bare slug. */
  const local = (name: string): string => (name.startsWith(`${recipe}/`) ? name.slice(recipe.length + 1) : name);
  const locate = (name: string): Location => {
    if (own.has(local(name))) return "own";
    const matches = name.includes("/") ? others.filter((r) => phaseTitle(r.recipe, r.phase.slug) === name) : others.filter((r) => r.phase.slug === name);
    const recipes = new Set(matches.map((r) => r.recipe));
    return recipes.size > 1 ? "ambiguous" : recipes.size === 1 ? "registered" : undefined;
  };
  const missing = (name: string) => {
    const hint = name === "source" ? " (an entry phase lists the classes it starts under entry)" : "";
    return `"${name}" is not a registered phase, in this bundle or in another recipe's latest revision${hint}`;
  };
  const ambiguous = (name: string) => `"${name}" is a phase of more than one registered recipe: name it <recipe>/${name}`;

  for (const phase of phases) {
    const fail = (rule: string, message: string) => findings.push({ phase: phaseTitle(recipe, phase.slug), rule, message });
    /** Resolves the name; a dangling or ambiguous one is a finding. True when it lands in this bundle. */
    const inBundle = (rule: string, name: string): boolean => {
      const location = locate(name);
      if (location === undefined) fail(rule, missing(name));
      else if (location === "ambiguous") fail(rule, ambiguous(name));
      return location === "own";
    };

    for (const edge of phase.to) {
      if (inBundle("to", edge.phase) && !own.get(local(edge.phase))!.from.map(local).includes(phase.slug)) {
        fail("to", `target "${edge.phase}" does not list ${phase.slug} in its from`);
      }
    }
    for (const name of phase.from) {
      if (inBundle("from", name) && !own.get(local(name))!.to.some((edge) => local(edge.phase) === phase.slug)) {
        fail("from", `"${name}" does not list ${phase.slug} in its to`);
      }
    }
    if (phase.entry.length && phase.needs !== undefined) {
      fail("needs", `an entry phase has no needs: intake assigns it mechanically, with no turn to judge prose (entry: ${phase.entry.join(", ")})`);
    }
  }

  // Exactly one entry phase per class the bundle claims.
  const claims = new Map<string, string[]>();
  for (const phase of phases) for (const className of phase.entry) claims.set(className, [...(claims.get(className) ?? []), phase.slug]);
  for (const [className, slugs] of claims) {
    if (slugs.length > 1) {
      for (const slug of slugs) findings.push({ phase: phaseTitle(recipe, slug), rule: "entry", message: `class ${className} has more than one entry phase: ${slugs.join(", ")}` });
    }
  }

  return findings;
}
