// The lay helper behind `plugin/bin/lay.mjs`: the mechanical parts of a turn's reconcile and close-out,
// so the turn driver's prose stays short and the bead shapes stay in one place. It runs inside a turn,
// under the station actor the session carries in BEADS_ACTOR, and every write goes through the space
// wrapper as `<owner>/<station>`. What it judges is mechanical only: the station chosen by the driver
// lists the phase's model and every repository the order names; a phase is laid from the order's pinned
// revision, or pins the recipe an edge crosses into; a pass phase is never laid as a phase; the rounds
// cap is counted, and passed over only for a phase laid behind a pass (`--behind`), where the person's
// word grants the round; a phase laid with no `--station` waits unassigned behind a `no station for`
// pass for the person's `retry <station>`; a pass is never closed. The prose judgments (needs against
// offers, `when`, `skip when`, the answer on a pass) stay with the driver.
import { parseActor } from "../actor.ts";
import { readHostConfig } from "../config.ts";
import { labelValue, withNoteLine } from "../fields.ts";
import { parseLaidPhase, LaidPhaseError } from "../laid.ts";
import { parseOrder, recipePins, withPin } from "../order.ts";
import type { Order, Pin } from "../order.ts";
import { isPass, parsePhaseFile, PhaseError, splitTitle } from "../recipe/phase.ts";
import type { Phase } from "../recipe/phase.ts";
import { readRecipe, readStations, RecipeError, SUPERSEDED } from "../registered.ts";
import type { CommandRunner } from "../runner.ts";
import { openSpace, RefusedError, SpaceError } from "../space.ts";
import type { Bead, Space } from "../space.ts";
import { lacks } from "../station.ts";
import type { Station } from "../station.ts";

export interface LayDeps {
  runner: CommandRunner;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The brief of a pass, when `--brief -` says it comes on stdin. */
  stdin?: () => Promise<string>;
}

/** The exit codes: usage or no config, a refusal before any write, the rounds cap. */
export const EXIT = { ok: 0, usage: 1, refused: 2, rounds: 3 } as const;

export const USAGE = `Usage: lay <subcommand>

  lay phase <order> <slug> [--station <title>] --why <reason> [--blocked-by <id>]... [--behind <pass>] [--title <qualifier>] [--note <line>]...
  lay pass <order> [<pass slug>] [--title <title>] [--blocks <id>] --brief <text>   (--brief - reads stdin)
  lay assign <phase> --station <title> --why <reason>
  lay dep <id> <blocked-by>...
  lay close <id> --reason <artifact>
  lay reopen <id>
  lay label <id> <label>...
  lay note <bead> <key> <value>
`;

/** A call refused before any write: the message names why. */
class LayRefusal extends Error {
  readonly code: number;
  constructor(message: string, code: number = EXIT.refused) {
    super(message);
    this.name = "LayRefusal";
    this.code = code;
  }
}

class LayUsage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayUsage";
  }
}

interface Args {
  positional: string[];
  options: Map<string, string[]>;
}

/** The note a laid phase carries beside its model: why the driver chose the station, or, laid with none, what every station lacks. */
const ASSIGNED = "assigned";
const UNASSIGNED = "unassigned";

/** The `phase:<slug>` label and the `station:<title>` label of a laid phase. */
const phaseLabel = (slug: string) => `phase:${slug}`;
const stationLabel = (title: string) => `station:${title}`;

/** The title of a pass laid from a pass phase: the slug with spaces. */
const passTitle = (slug: string) => slug.replaceAll("-", " ");

export async function lay(argv: readonly string[], deps: LayDeps): Promise<number> {
  const fail = (text: string): number => {
    deps.stderr(`lay: ${text}\n`);
    return EXIT.usage;
  };
  const [subcommand, ...rest] = argv;
  const run = SUBCOMMANDS[subcommand ?? ""];
  if (!run) return fail(`${subcommand ? `unknown subcommand ${subcommand}` : "no subcommand"}\n\n${USAGE}`);

  const name = deps.env.BEADS_ACTOR;
  const actor = name ? parseActor(name) : undefined;
  if (!actor || actor.kind !== "station") {
    deps.stderr(`lay: BEADS_ACTOR is ${name ?? "unset"}, not a station: lay runs inside a turn, writing as <owner>/<station>\n`);
    return EXIT.refused;
  }
  const config = readHostConfig(deps.env);
  if (!config) return fail("no host config: run kitchen init first");
  const space = openSpace({ runner: deps.runner, env: deps.env, config, actor });

  try {
    await run({ space, owner: actor.owner, args: parseArgs(rest), deps });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof LayUsage) return fail(`${error.message}\n\n${USAGE}`);
    if (error instanceof LayRefusal || error instanceof RefusedError) {
      deps.stderr(`lay: ${error.message}\n`);
      return error instanceof LayRefusal ? error.code : EXIT.refused;
    }
    if (error instanceof SpaceError || error instanceof LaidPhaseError || error instanceof RecipeError) return fail(error.message);
    throw error;
  }
}

interface Context {
  space: Space;
  /** The person the turn writes for: the station's owner, whose pass a laid pass is. */
  owner: string;
  args: Args;
  deps: LayDeps;
}

type Subcommand = (context: Context) => Promise<void>;

const SUBCOMMANDS: Record<string, Subcommand> = {
  async phase({ space, args, deps }) {
    const given = positional(args, 2, "lay phase <order> <slug> [--station <title>] --why <reason>");
    const [orderId, slug] = [given.at(0), given.at(1)];
    const stationTitle = args.options.get("station")?.[0];
    const why = option(args, "why", "lay phase needs --why <reason>: the note saying why this station, or what every station lacks");
    const behind = args.options.get("behind")?.[0];
    const blockedBy = [...(args.options.get("blocked-by") ?? []), ...(behind === undefined ? [] : [behind])];
    const qualifier = args.options.get("title")?.[0];
    const notes = args.options.get("note") ?? [];

    const orderBead = await space.show(orderId);
    const order = parseOrder(orderBead);
    const found = await registeredPhase(space, orderBead, slug);
    if (isPass(found.phase)) throw new LayRefusal(`${slug} is a pass phase (skill: human): lay it with lay pass`);
    const station = stationTitle === undefined ? undefined : await qualifyingStation(space, stationTitle, found.phase, order);
    const children = await space.list({ parent: order.id, all: true });

    const title = `${slug}: ${qualifier ?? order.title}`;
    const existing = children.find((child) => child.title === title && child.status !== "closed");
    if (existing) {
      for (const blocker of blockedBy) await space.addDependency(existing.id, blocker);
      deps.stdout(`${slug} is laid already as ${existing.id}${blockedBy.length ? `; it now waits for ${blockedBy.join(", ")}` : ""}\n`);
      return;
    }
    const laid = children.filter((child) => labelValue(child, "phase") === slug).length;
    // Behind a pass the cap is the person's to pass over: their word on the pass grants the round.
    if (behind === undefined && found.phase.rounds !== undefined && laid >= found.phase.rounds) {
      throw new LayRefusal(`rounds reached: ${slug} (${laid} laid, rounds: ${found.phase.rounds})`, EXIT.rounds);
    }
    // Umka's rule: an open sibling whose phase the new one lists under `from` finishes first.
    const siblings = children
      .filter((child) => child.status !== "closed" && !blockedBy.includes(child.id))
      .filter((child) => found.phase.from.includes(labelValue(child, "phase") ?? ""))
      .map((child) => child.id);

    if (found.pinned) {
      // The order was read above; its notes are rewritten from that read rather than read again.
      const notes = orderBead.notes ?? "";
      await space.update(orderBead, { notes: withNoteLine(notes, "recipe", withPin(notes, found.pinned)) });
      deps.stdout(`Pinned ${found.pinned.name} ${found.pinned.revision} on ${order.id}\n`);
    }
    const bead = await space.create({
      title,
      type: "task",
      parent: order.id,
      labels: [phaseLabel(slug), ...(station ? [stationLabel(station.title)] : [])],
      notes: [`model: ${found.phase.model ?? ""}`, `${station ? ASSIGNED : UNASSIGNED}: ${why}`, ...notes].join("\n"),
      description: found.phase.text,
      ...(station ? { assignee: station.title } : {}),
      ...(blockedBy.length ? { blockedBy } : {}),
    });
    for (const sibling of siblings) await space.addDependency(bead.id, sibling);
    const blockers = [...blockedBy, ...siblings];
    deps.stdout(`Laid ${slug} as ${bead.id} ${station ? `at ${station.title}` : "unassigned"}${blockers.length ? `, blocked by ${blockers.join(", ")}` : ""}\n`);
  },

  async pass({ space, owner, args, deps }) {
    const given = positional(args, 1, "lay pass <order> [<pass slug>] [--title <title>] [--blocks <id>] --brief <text>");
    const [orderId, slug] = [given.at(0), given.rest(1)[0]];
    const titleOption = args.options.get("title")?.[0];
    const briefArg = option(args, "brief", "lay pass needs --brief <text> (or --brief - for stdin)");
    if (slug === undefined && titleOption === undefined) throw new LayUsage("lay pass needs a pass slug or --title <title>");

    const orderBead = await space.show(orderId);
    const order = parseOrder(orderBead);
    let title = titleOption;
    if (slug !== undefined) {
      const found = await registeredPhase(space, orderBead, slug);
      if (!isPass(found.phase)) throw new LayRefusal(`${slug} is not a pass phase (skill: human): lay it with lay phase`);
      title ??= passTitle(slug);
    }
    const blocks = args.options.get("blocks")?.[0] ?? order.id;
    const brief = briefArg === "-" ? (await readStdin(deps)).trim() : briefArg;

    const gate = await space.layPass({ order: order.id, blocks, title: title ?? "", brief, owner, ...(slug !== undefined ? { labels: [phaseLabel(slug)] } : {}) });
    deps.stdout(`Laid pass ${slug ?? title} as ${gate.id} for ${owner}, blocking ${blocks}\n`);
  },

  async assign({ space, args, deps }) {
    const phaseId = positional(args, 1, "lay assign <phase> --station <title> --why <reason>").at(0);
    const stationTitle = option(args, "station", "lay assign needs --station <title>");
    const why = option(args, "why", "lay assign needs --why <reason>");

    const bead = await space.show(phaseId);
    const laid = parseLaidPhase(bead);
    const phase = parsePhaseFile(bead.description ?? "", `${laid.slug}.md`);
    const order = parseOrder(await space.show(laid.order));
    const station = await qualifyingStation(space, stationTitle, phase, order);
    await space.update(bead, {
      appendNotes: `${ASSIGNED}: ${why}`,
      addLabels: [stationLabel(station.title)],
      removeLabels: [stationLabel(laid.station)],
      assignee: station.title,
    });
    deps.stdout(`Assigned ${phaseId} to ${station.title}\n`);
  },

  async dep({ space, args, deps }) {
    const given = positional(args, 2, "lay dep <id> <blocked-by>...");
    const [id, blockers] = [given.at(0), given.rest(1)];
    for (const blocker of blockers) await space.addDependency(id, blocker);
    deps.stdout(`${id} is blocked by ${blockers.join(", ")}\n`);
  },

  async close({ space, args, deps }) {
    const id = positional(args, 1, "lay close <id> --reason <artifact>").at(0);
    const reason = option(args, "reason", "lay close needs --reason <artifact>");
    const bead = await space.show(id);
    if (bead.issue_type === "gate") {
      throw new LayRefusal(
        bead.await_type === "human"
          ? `${id} is a pass: a pass closes only under a person's name, through kitchen pass or the UI, never through the turn driver`
          : `${id} is a typed gate (${bead.await_type ?? "unknown"}): the expeditor closes it when the wait resolves`,
      );
    }
    await space.close(bead, reason);
    deps.stdout(`Closed ${id}: ${reason}\n`);
  },

  async reopen({ space, args, deps }) {
    const id = positional(args, 1, "lay reopen <id>").at(0);
    await space.update(unreadBead(id), { status: "open" });
    deps.stdout(`Reopened ${id}\n`);
  },

  async label({ space, args, deps }) {
    const given = positional(args, 2, "lay label <id> <label>...");
    const [id, labels] = [given.at(0), given.rest(1)];
    await space.update(unreadBead(id), { addLabels: labels });
    deps.stdout(`Labelled ${id} ${labels.join(", ")}\n`);
  },

  async note({ space, args, deps }) {
    const given = positional(args, 3, "lay note <bead> <key> <value>");
    const [id, key, value] = [given.at(0), given.at(1), given.at(2)];
    await space.setNote(unreadBead(id), key, value);
    deps.stdout(`${id} ${key}: ${value}\n`);
  },
};

/** A bead written without being read first: a phase or a pass, never one of the registered types the wrapper refuses an edit of. */
const unreadBead = (id: string) => ({ id, issue_type: "task" });

/**
 * The registered phase a slug names for this order: from a revision the order pinned, else from the
 * latest revision of the one recipe holding it that the order has not pinned, which the order then
 * pins (the crossing of an edge into another recipe). A slug missing from the order's own pinned
 * revision is never read from a newer one: re-pinning a running order is a human act outside v1.
 */
async function registeredPhase(space: Space, order: Bead, slug: string): Promise<{ phase: Phase; pinned?: Pin }> {
  const beads = await space.list({ type: "phase" });
  const parse = (bead: Bead): Phase => {
    try {
      return parsePhaseFile(bead.description ?? "", `${slug}.md`);
    } catch (error) {
      if (error instanceof PhaseError) throw new LayRefusal(`${bead.id} (${bead.title}) does not parse as a phase: ${error.message}`);
      throw error;
    }
  };
  const pins = recipePins(order.notes ?? "");
  const pinned = beads.find((bead) => pins.some((pin) => bead.title === `${pin.name}/${slug}` && bead.labels?.includes(pin.revision)));
  if (pinned) return { phase: parse(pinned) };

  const recipes = [...new Set(
    beads
      .filter((bead) => splitTitle(bead.title)?.slug === slug && !bead.labels?.includes(SUPERSEDED))
      .map((bead) => splitTitle(bead.title)?.recipe ?? "")
      .filter((name) => !pins.some((pin) => pin.name === name)),
  )];
  if (recipes.length === 0) {
    const walked = pins.map((pin) => `${pin.name} ${pin.revision}`).join(", ");
    throw new LayRefusal(`no recipe this order has not pinned holds a phase named ${slug}${walked ? ` (pinned: ${walked})` : ""}`);
  }
  const [name] = recipes;
  if (recipes.length > 1 || name === undefined) throw new LayRefusal(`${slug} is a phase of more than one recipe (${recipes.join(", ")}): the edge is ambiguous`);
  const recipe = await readRecipe(space, name, beads);
  const phase = recipe.phases.find((p) => p.slug === slug);
  if (!phase) throw new LayRefusal(`${name}'s latest revision holds no phase named ${slug}`);
  return { phase, pinned: { name, revision: recipe.revision } };
}

/** The station the driver chose, when it is registered and lacks nothing mechanical: the phase's model, every repository the order names. */
async function qualifyingStation(space: Space, title: string, phase: Phase, order: Order): Promise<Station> {
  const station = (await readStations(space)).find((s) => s.title === title);
  if (!station) throw new LayRefusal(`no station titled ${title} is registered`);
  const gap = lacks(station, { model: phase.model, repos: order.repos });
  if (gap.length) throw new LayRefusal(`no station for ${phase.slug} at ${title}: it lacks ${gap.join(", ")}`);
  return station;
}

async function readStdin(deps: LayDeps): Promise<string> {
  if (!deps.stdin) throw new LayUsage("--brief - needs stdin, and none is attached");
  return deps.stdin();
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined) throw new LayUsage(`${arg} needs a value`);
      const key = arg.slice(2);
      options.set(key, [...(options.get(key) ?? []), value]);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

/** The positional arguments, at least `count` of them; `at` reads one that is there, `rest` the tail. */
function positional(args: Args, count: number, usage: string): { at(i: number): string; rest(from: number): string[] } {
  if (args.positional.length < count) throw new LayUsage(usage);
  return {
    at: (i) => args.positional[i] ?? "",
    rest: (from) => args.positional.slice(from),
  };
}

function option(args: Args, key: string, usage: string): string {
  const value = args.options.get(key)?.[0];
  if (value === undefined) throw new LayUsage(usage);
  return value;
}
