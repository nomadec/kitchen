// Intake: the one function behind `kitchen order add` and the expeditor's source poll. It checks the
// source is not an order already, pins the recipe's latest revision, creates the order bead, and lays
// the recipe's entry phase for the class, assigned mechanically (ADR 0002's one exception) or, when no
// station qualifies, unassigned behind a pass naming the gap, so the owner's `retry` or `retry
// <station>` on the pass resumes the order (answers.ts).
import { orderFields, parseOrder, LOOP } from "./order.ts";
import type { Order, OrderSource } from "./order.ts";
import type { Phase } from "./recipe/phase.ts";
import { readRecipe, readStations } from "./registered.ts";
import type { OrderClass } from "./source.ts";
import type { Bead, Space } from "./space.ts";
import { lacks } from "./station.ts";
import type { Need, Station } from "./station.ts";

/** The note intake writes on the entry phase: the one assignment no turn made. */
export const ENTRY_NOTE = "entry: mechanical";

/** The title of the pass intake lays when no station qualifies: `no station for <slug>`. */
export const NO_STATION = "no station for";

export interface IntakeRequest {
  source: OrderSource;
  recipe: string;
  class: OrderClass;
  repos: readonly string[];
  /** The person whose stations the entry phase may go to, and whose pass it is when none qualifies. */
  owner: string;
}

export type IntakeResult =
  /** An order for the source exists; nothing was created. */
  | { kind: "existing"; orders: Order[] }
  /** The order and its entry phase, assigned to a station. */
  | { kind: "laid"; order: Bead; revision: string; phase: Bead; station: Station; slug: string }
  /** The order, its entry phase laid unassigned, and the pass that names the gap: no station of the owner qualifies. */
  | { kind: "pass"; order: Bead; revision: string; phase: Bead; pass: Bead; slug: string; gap: string };

/** A request intake refuses before creating anything; the message names what is wrong. */
export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeError";
  }
}

export async function intake(space: Space, request: IntakeRequest): Promise<IntakeResult> {
  const existing = await findExisting(space, request.source);
  if (existing.length) return { kind: "existing", orders: existing };

  const recipe = await readRecipe(space, request.recipe);
  const entry = recipe.phases.find((phase) => phase.entry.includes(request.class));
  if (!entry) throw new IntakeError(`${recipe.name} ${recipe.revision} has no entry phase for class ${request.class}`);
  const need: Need = { model: entry.model, repos: request.repos };
  const stations = await readStations(space, { owner: request.owner });
  const chosen = await chooseStation(space, stations, need);

  const order = await space.create(
    orderFields({ source: request.source, repos: request.repos, recipe: recipe.name, revision: recipe.revision, class: request.class }),
  );
  const phase = await space.create({
    title: `${entry.slug}: ${request.source.title}`,
    type: "task",
    parent: order.id,
    labels: [`phase:${entry.slug}`, ...(chosen ? [`station:${chosen.title}`] : [])],
    notes: [`model: ${entry.model ?? ""}`, ENTRY_NOTE].join("\n"),
    description: entry.text,
    ...(chosen ? { assignee: chosen.title } : {}),
  });
  if (chosen) return { kind: "laid", order, revision: recipe.revision, phase, station: chosen, slug: entry.slug };
  const gap = describeGap(request.owner, entry, need, stations);
  const pass = await layNoStationPass(space, { order: order.id, phase: phase.id, slug: entry.slug, gap, owner: request.owner });
  return { kind: "pass", order, revision: recipe.revision, phase, pass, slug: entry.slug, gap };
}

/** The `no station for <slug>` pass behind which an unassigned phase waits for the owner's word. */
export function layNoStationPass(space: Space, fields: { order: string; phase: string; slug: string; gap: string; owner: string }): Promise<Bead> {
  return space.layPass({ order: fields.order, blocks: fields.phase, title: `${NO_STATION} ${fields.slug}`, brief: fields.gap, owner: fields.owner });
}

/** Umka's duplicate check: the exact external reference, then its substring. */
async function findExisting(space: Space, source: OrderSource): Promise<Order[]> {
  const exact = await space.list({ type: "epic", labels: [LOOP], externalRef: source.externalRef });
  if (exact.length) return exact.map(parseOrder);
  const near = await space.list({ type: "epic", labels: [LOOP], externalContains: source.externalContains });
  return near.map(parseOrder);
}

/**
 * The mechanical choice: among the owner's stations lacking nothing the phase and its order need,
 * unattended before attended, then the fewest running turns (the phases in progress assigned to the
 * station, which a claim sets; the order a station holds is assigned to it too and is not a turn),
 * then the order the space lists them in. The expeditor's `retry` on a `no station for` pass makes
 * the same choice again.
 */
export async function chooseStation(space: Space, stations: readonly Station[], need: Need): Promise<Station | undefined> {
  const qualifying = stations.filter((station) => lacks(station, need).length === 0);
  if (qualifying.length === 0) return undefined;
  const load = new Map<string, number>();
  for (const station of qualifying) {
    load.set(station.id, (await space.list({ assignee: station.title, status: "in_progress" })).filter((bead) => bead.issue_type !== "epic").length);
  }
  return [...qualifying].sort((a, b) => Number(a.attended) - Number(b.attended) || (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0];
}

/** The brief of the pass: what the phase needs and what each station of the owner lacks. */
export function describeGap(owner: string, phase: Pick<Phase, "slug">, need: Need, stations: readonly Station[]): string {
  const needs = `${phase.slug} needs model ${need.model ?? "(none)"}${need.repos.length ? ` and ${need.repos.join(", ")} checked out` : ""}`;
  if (!stations.length) return `${needs}; ${owner} has no registered station`;
  return `${needs}; ${stations.map((station) => `${station.title} lacks ${lacks(station, need).join(", ")}`).join("; ")}`;
}
