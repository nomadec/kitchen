// kitchen station add: register a station on this host from a template and the values only this host knows.
import { parseArgs } from "node:util";
import type { Command } from "../cli.ts";
import { RefusedError } from "../space.ts";
import { StationError, stationFields } from "../station.ts";
import { loadTemplate } from "../station-template.ts";
import type { StationValues } from "../station.ts";
import { openRegistrationSpace } from "./host-space.ts";

const USAGE = `Usage: kitchen station add <template> [options]

The template is a station.json file, or a plugin directory holding one; it gives the shape.
The options give the values only this host knows.

Options:
  --repo <slug>=<path>   The local checkout of a repository the template offers (one per repository)
  --cap <n>              How many turns the station runs at once (required)
  --timeout <duration>   The wall-clock timeout of one turn, such as 45m (required)
  --name <name>          The station's name; the bead is titled <owner>/<name> (default: the template's)
  --owner <person>       The station's owner (default: the host config's owner)
  --host <hostname>      The host the station runs on (default: the host config's host)
  --offers <prose>       What the station offers, in prose (default: the template's)
  --secret <name>        The name of a secret the host resolves at launch; never its value (repeatable)
  --attended             A human sits at this station; its turns start only on their word
`;

export const stationAdd: Command = async (args, deps) => {
  const fail = (message: string): number => {
    deps.stderr(`kitchen station add: ${message}\n\n${USAGE}`);
    return 1;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  const opened = openRegistrationSpace(deps, "station");
  if ("error" in opened) return fail(opened.error);
  const { space, config } = opened;

  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const [template, options] = parsed;
  if (!template) return fail("a template is required");

  const values: StationValues = {
    owner: options.owner ?? config.owner,
    host: options.host ?? config.host,
    paths: {},
    secrets: options.secret ?? [],
    attended: options.attended ?? false,
  };
  if (options.name) values.name = options.name;
  if (options.offers) values.offers = options.offers;
  if (options.cap !== undefined) {
    if (!/^\d+$/.test(options.cap)) return fail(`--cap must be a whole number of turns, got ${options.cap}`);
    values.cap = Number(options.cap);
  }
  if (options.timeout) values.timeout = options.timeout;
  for (const entry of options.repo ?? []) {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) return fail(`--repo must be <slug>=<path>, got ${entry}`);
    values.paths[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  try {
    const bead = await space.create(stationFields(loadTemplate(template), values));
    deps.stdout(`Registered station ${bead.title} as ${bead.id} on ${values.host}\n`);
    return 0;
  } catch (error) {
    if (error instanceof StationError) return fail(error.message);
    if (error instanceof RefusedError) {
      deps.stderr(`kitchen station add: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
};

function parseOptions(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      repo: { type: "string", multiple: true },
      cap: { type: "string" },
      timeout: { type: "string" },
      name: { type: "string" },
      owner: { type: "string" },
      host: { type: "string" },
      offers: { type: "string" },
      secret: { type: "string", multiple: true },
      attended: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  return [positionals[0], values] as const;
}
