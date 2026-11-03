// The reader of what is registered: the station and source beads, read back from the space for
// intake (which assigns the entry phase), the laying turn (which chooses a station) and the expeditor
// (which starts its host's stations and polls its host's sources).
import { parseSource } from "./source.ts";
import type { Source } from "./source.ts";
import type { Space } from "./space.ts";
import { parseStation } from "./station.ts";
import type { Station } from "./station.ts";

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
