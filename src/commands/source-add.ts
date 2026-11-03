// kitchen source add: register a polled source with its kind, target, recipe and class.
import { parseArgs } from "node:util";
import type { Command } from "../cli.ts";
import { CLASSES, isOrderClass, isSourceKind, sourceFields } from "../source.ts";
import { RefusedError } from "../space.ts";
import { openRegistrationSpace } from "./host-space.ts";

const USAGE = `Usage: kitchen source add --kind <github|file> --target <target> --recipe <name> [options]

Options:
  --kind <github|file>   Where the items come from: a GitHub repository's issues, or a JSONL file (required)
  --target <target>      The repository slug for github, the JSONL path for file (required)
  --recipe <name>        The recipe every order from this source follows (required)
  --class <class>        The class its items enter with: ${CLASSES.join(", ")} (default: unsorted)
  --host <hostname>      The one host whose expeditor polls it (default: this host)
`;

export const sourceAdd: Command = async (args, deps) => {
  const fail = (message: string): number => {
    deps.stderr(`kitchen source add: ${message}\n\n${USAGE}`);
    return 1;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  const opened = openRegistrationSpace(deps, "source");
  if ("error" in opened) return fail(opened.error);
  const { space, config } = opened;

  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        kind: { type: "string" },
        target: { type: "string" },
        recipe: { type: "string" },
        class: { type: "string" },
        host: { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!values.kind) return fail("--kind <github|file> is required");
  if (!isSourceKind(values.kind)) return fail(`--kind must be github or file, got ${values.kind}`);
  if (!values.target) return fail("--target <repository slug or JSONL path> is required");
  if (!values.recipe) return fail("--recipe <name> is required");
  const cls = values.class ?? "unsorted";
  if (!isOrderClass(cls)) return fail(`--class must be one of ${CLASSES.join(", ")}, got ${cls}`);
  const host = values.host ?? config.host;

  try {
    const bead = await space.create(
      sourceFields({ owner: config.owner, host, kind: values.kind, target: values.target, recipe: values.recipe, class: cls }),
    );
    deps.stdout(`Registered source ${bead.title} as ${bead.id}, polled by ${host}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RefusedError) {
      deps.stderr(`kitchen source add: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
};
