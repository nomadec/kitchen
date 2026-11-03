// kitchen recipe add: register a recipe as a new revision of phase beads, after linting the bundle
// against the latest revision of every other recipe in the space. A human act (story 33).
import { parseArgs } from "node:util";
import type { Command } from "../cli.ts";
import { actorName, resolveActor } from "../actor.ts";
import { readHostConfig } from "../config.ts";
import { discover, fetchBundle, BundleError, revisionOf } from "../recipe/bundle.ts";
import type { Bundle } from "../recipe/bundle.ts";
import { describeFinding, lintBundle } from "../recipe/lint.ts";
import type { RegisteredPhase } from "../recipe/lint.ts";
import { parsePhaseFile, PhaseError, phaseTitle, slugOf, splitTitle } from "../recipe/phase.ts";
import { openSpace, RefusedError, RULE } from "../space.ts";
import type { Bead } from "../space.ts";

const USAGE = `Usage: kitchen recipe add <plugin-dir|file|url> [--recipe <name>]

Registers a recipe: the phase files under the plugin's phases directory (or the directory of
phase files itself), one file, or one fetched from a URL. The bundle is linted with every other
recipe in the space and refused whole on any failure. On success one phase bead per file is
created under a new revision and the previous revision's beads are labelled superseded. Laid
phases are untouched.

Options:
  --recipe <name>   The recipe name; required for a file or a URL (a plugin names itself)
`;

const SUPERSEDED = "superseded";

export const recipeAdd: Command = async (args, deps) => {
  const refuse = (message: string): number => {
    deps.stderr(`kitchen recipe add: ${message}\n`);
    return 1;
  };
  const options = parseOptions(args);
  if ("error" in options) return refuse(`${options.error}\n\n${USAGE}`);

  const config = readHostConfig(deps.env);
  if (!config) return refuse("no host config: run kitchen init first");
  const actor = resolveActor(deps.env, config);
  if (actor.kind !== "human") {
    return refuse(`${actorName(actor)} may not register a recipe: registration is a human act (${RULE})`);
  }

  let bundle: Bundle;
  try {
    bundle = /^https?:\/\//.test(options.target)
      ? await fetchBundle(options.target, options.recipe, deps.runner)
      : discover(options.target, options.recipe);
  } catch (error) {
    if (error instanceof BundleError) return refuse(error.message);
    throw error;
  }
  const revision = `rev:${revisionOf(bundle.files)}`;

  const space = openSpace({ runner: deps.runner, env: deps.env, config, actor });
  const current = (await space.list({ type: "phase" })).filter((bead) => !bead.labels?.includes(SUPERSEDED));
  const previous = current.filter((bead) => splitTitle(bead.title)?.recipe === bundle.recipe);
  if (previous.length && previous.every((bead) => bead.labels?.includes(revision))) {
    deps.stdout(`${bundle.recipe} ${revision} is already the latest revision; nothing to register.\n`);
    return 0;
  }

  const findings = lintBundle(bundle.recipe, bundle.files, registeredPhases(current, bundle.recipe));
  if (findings.length) {
    return refuse(`refused ${bundle.recipe}: ${count(findings.length, "lint failure")}\n${findings.map((f) => `  ${describeFinding(f)}`).join("\n")}`);
  }

  try {
    for (const { file, text } of bundle.files) {
      await space.create({ title: phaseTitle(bundle.recipe, slugOf(file)), type: "phase", labels: [revision], description: text });
    }
    for (const bead of previous) await space.update(bead, { addLabels: [SUPERSEDED] });
  } catch (error) {
    if (error instanceof RefusedError) return refuse(error.message);
    throw error;
  }
  const superseded = previous.length ? `; ${count(previous.length, "bead")} of the previous revision labelled ${SUPERSEDED}` : "";
  deps.stdout(`Registered ${bundle.recipe} ${revision} with ${count(bundle.files.length, "phase")}${superseded}.\n`);
  return 0;
};

function parseOptions(args: readonly string[]): { target: string; recipe: string | undefined } | { error: string } {
  try {
    const { positionals, values } = parseArgs({ args: [...args], options: { recipe: { type: "string" } }, allowPositionals: true, strict: true });
    const target = positionals[0];
    if (target === undefined || target === "") return { error: "a plugin directory, a file or a URL is required" };
    return { target, recipe: values.recipe };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The other recipes' latest revisions, as the lint reads them. A bead whose title or description does not parse is skipped. */
function registeredPhases(current: readonly Bead[], recipe: string): RegisteredPhase[] {
  const phases: RegisteredPhase[] = [];
  for (const bead of current) {
    const title = splitTitle(bead.title);
    if (!title || title.recipe === recipe || typeof bead.description !== "string") continue;
    try {
      phases.push({ recipe: title.recipe, phase: parsePhaseFile(bead.description, `${title.slug}.md`) });
    } catch (error) {
      if (!(error instanceof PhaseError)) throw error;
    }
  }
  return phases;
}
