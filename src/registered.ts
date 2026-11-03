// The reader of what is registered: the station, source and phase beads, read back from the space for
// intake (which pins a revision and assigns the entry phase), the laying turn (which chooses a station)
// and the expeditor (which starts its host's stations and polls its host's sources).
import { parsePhaseFile, PhaseError, splitTitle } from "./recipe/phase.ts";
import type { Phase } from "./recipe/phase.ts";
import { parseSource } from "./source.ts";
import type { Source } from "./source.ts";
import type { Space } from "./space.ts";
import { parseStation } from "./station.ts";
import type { Station } from "./station.ts";

/** The label `kitchen recipe add` puts on the beads of a revision that a newer one replaced. */
export const SUPERSEDED = "superseded";

/** A recipe's latest revision: the `rev:<revision>` label and the phases of its beads. */
export interface Recipe {
  name: string;
  revision: string;
  phases: Phase[];
}

/** A recipe that cannot be read as one revision; the message names the gap. */
export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeError";
  }
}

/**
 * The latest revision of a recipe: its phase beads not labelled superseded, parsed back. Refused when
 * the recipe is not registered, when those beads span more than one revision (a registration that did
 * not finish), or when one of them does not parse.
 */
export async function readRecipe(space: Space, name: string): Promise<Recipe> {
  const beads = (await space.list({ type: "phase" })).filter(
    (bead) => splitTitle(bead.title)?.recipe === name && !bead.labels?.includes(SUPERSEDED),
  );
  if (!beads.length) throw new RecipeError(`recipe ${name} is not registered: run kitchen recipe add first`);
  const revisions = new Set(beads.map((bead) => bead.labels?.find((label) => label.startsWith("rev:")) ?? ""));
  const [revision] = revisions;
  if (revisions.size !== 1 || !revision) {
    throw new RecipeError(`recipe ${name} has beads of more than one revision not superseded (${[...revisions].join(", ") || "none"}): register it again`);
  }
  const phases = beads.map((bead) => {
    const slug = splitTitle(bead.title)?.slug ?? "";
    try {
      return parsePhaseFile(typeof bead.description === "string" ? bead.description : "", `${slug}.md`);
    } catch (error) {
      if (error instanceof PhaseError) throw new RecipeError(`${bead.id} (${bead.title}) does not parse as a phase: ${error.message}`);
      throw error;
    }
  });
  return { name, revision, phases };
}

/** The owner and the host a registered bead carries as labels. */
export interface RegisteredFilter {
  owner?: string;
  host?: string;
}

/** The registered stations, narrowed by owner and host when given. */
export async function readStations(space: Space, filter: RegisteredFilter = {}): Promise<Station[]> {
  const beads = await space.list({ type: "station", labels: labelsOf(filter) });
  return beads.map(parseStation);
}

export async function readStation(space: Space, id: string): Promise<Station> {
  return parseStation(await space.show(id));
}

/** The registered sources, narrowed to those one host polls when given. */
export async function readSources(space: Space, filter: RegisteredFilter = {}): Promise<Source[]> {
  const beads = await space.list({ type: "source", labels: labelsOf(filter) });
  return beads.map(parseSource);
}

export async function readSource(space: Space, id: string): Promise<Source> {
  return parseSource(await space.show(id));
}

function labelsOf(filter: RegisteredFilter): string[] {
  return [...(filter.owner ? [`owner:${filter.owner}`] : []), ...(filter.host ? [`host:${filter.host}`] : [])];
}
