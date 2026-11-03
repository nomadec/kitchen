// kitchen order add: a GitHub issue URL, a file path or free text becomes an order through intake.
// The command reads the source (gh for an issue), infers the class when none is given, and prints
// what intake made: the order and its entry phase, the pass naming the gap, or the order that
// already exists.
import { parseArgs } from "node:util";
import type { Command } from "../cli.ts";
import { intake, IntakeError } from "../intake.ts";
import { readItem } from "../item.ts";
import type { ReadItem } from "../item.ts";
import { describeOrder } from "../order.ts";
import { RecipeError } from "../registered.ts";
import { CLASSES, isOrderClass } from "../source.ts";
import type { OrderClass } from "../source.ts";
import { openHostSpace } from "./host-space.ts";

const USAGE = `Usage: kitchen order add <source> --recipe <name> [options]

The source is a GitHub issue URL, a file path, or free text. The order pins the recipe's latest
revision and enters with a class; the recipe's entry phase for that class is laid and assigned to
one of your stations, or a pass names the gap.

Options:
  --recipe <name>   The recipe the order follows (required)
  --class <class>   The class it enters with: ${CLASSES.join(", ")}
                    (default: a GitHub issue labelled bug is a bug, ready-for-agent a spec, any other a ticket; a file or text is an idea)
  --repo <slug>     A repository the order names, by remote slug (repeatable; default: the issue's repository)
`;

export const orderAdd: Command = async (args, deps) => {
  const fail = (message: string): number => {
    deps.stderr(`kitchen order add: ${message}\n\n${USAGE}`);
    return 1;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { target, options } = parsed;
  if (!target) return fail("a source is required: a GitHub issue URL, a file path or free text");
  if (!options.recipe) return fail("--recipe <name> is required");
  const given = options.class;
  if (given !== undefined && !isOrderClass(given)) return fail(`--class must be one of ${CLASSES.join(", ")}, got ${given}`);

  const opened = openHostSpace(deps);
  if ("error" in opened) return fail(opened.error);
  const { space, config } = opened;

  let read: ReadItem;
  try {
    read = await readItem(target, deps.runner);
  } catch (error) {
    if (error instanceof IntakeError) return fail(error.message);
    throw error;
  }
  const cls: OrderClass = given ?? read.inferred;
  const repos = options.repo?.length ? options.repo : read.repos;

  let result;
  try {
    result = await intake(space, { source: read.source, recipe: options.recipe, class: cls, repos, owner: config.owner });
  } catch (error) {
    if (error instanceof IntakeError || error instanceof RecipeError) {
      deps.stderr(`kitchen order add: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  if (result.kind === "existing") {
    deps.stdout(`An order for ${read.source.externalRef} exists already:\n${result.orders.map((o) => `  ${describeOrder(o)}`).join("\n")}\n`);
    return 1;
  }
  deps.stdout(`Added order ${result.order.id} (${cls}, ${options.recipe} ${result.revision}) from ${read.source.externalRef}\n`);
  deps.stdout(
    result.kind === "laid"
      ? `Laid ${result.slug} as ${result.phase.id} at ${result.station.title} (entry: mechanical)\n`
      : `No station for ${result.slug}: laid ${result.phase.id} unassigned behind pass ${result.pass.id} (${result.gap})\n`,
  );
  return 0;
};

function parseOptions(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      recipe: { type: "string" },
      class: { type: "string" },
      repo: { type: "string", multiple: true },
    },
    allowPositionals: true,
    strict: true,
  });
  return { target: positionals.join(" "), options: values };
}
