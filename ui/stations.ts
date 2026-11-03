// The Stations view's data layer (spec: UI, story 67): every registered station read from bd serve
// with its owner, host, what it offers and its cap, the turns it runs now, and at an attended station
// the phases the expeditor marked waiting for `kitchen turn` with the exact command that starts each
// (no start button in v1: the turn is attended, so it runs in the human's own terminal). Reads only.
// No DOM here.
import { WAITING } from "../src/laid.ts";
import { parseOrder } from "../src/order.ts";
import type { Order } from "../src/order.ts";
import { nameOrder } from "../src/pass.ts";
import type { Bead } from "../src/space.ts";
import { parseStation } from "../src/station.ts";
import { client } from "./client.ts";
import type { ClientDeps } from "./client.ts";

/** One phase at a station: a turn running, or a phase waiting for the human. */
export interface StationPhase {
  id: string;
  title: string;
  /** `kitchen-20 (Stale cookie)`, or the id alone when the order is not among the open ones. */
  order: string;
}

export interface WaitingPhase extends StationPhase {
  /** The command to run in a terminal on the station's host. */
  command: string;
}

export interface StationRow {
  id: string;
  /** `<owner>/<name>`: the station title, the assignee of its phases and its turn actor. */
  title: string;
  owner: string;
  host: string;
  attended: boolean;
  offers: string;
  cap: number;
  running: StationPhase[];
  /** The ready phases of an attended station the expeditor labelled waiting (not held by another turn, not over the cap); always empty at an unattended one, where the expeditor starts them. */
  waiting: WaitingPhase[];
}

export interface StationsView {
  list(): Promise<StationRow[]>;
}

const assignedTo = (station: string) => `assignee=${encodeURIComponent(station)}`;

export function stationsView(deps: ClientDeps): StationsView {
  const api = client(deps);
  return {
    list: async () => {
      const beads = await api.list<Bead>("/v0/beads/issues?type=station&limit=0", "the list of stations");
      const stations = beads.map(parseStation);
      const orders = new Map<string, Order>((await api.list<Bead>("/v0/beads/issues?type=epic&label=loop&limit=0", "the list of orders")).map((bead) => [bead.id, parseOrder(bead)]));
      const phase = (bead: Bead): StationPhase => ({ id: bead.id, title: bead.title, order: nameOrder(typeof bead.parent === "string" ? bead.parent : undefined, orders) });
      const rows: StationRow[] = [];
      for (const station of stations) {
        // The order a station holds is assigned to it too; only the phases are turns.
        const running = (await api.list<Bead>(`/v0/beads/issues?${assignedTo(station.title)}&status=in_progress&limit=0`, `the turns at ${station.title}`)).filter((bead) => bead.issue_type !== "epic");
        const waiting = station.attended
          ? (await api.list<Bead>(`/v0/beads/ready?${assignedTo(station.title)}&limit=0`, `the phases waiting at ${station.title}`)).filter((bead) => bead.labels?.includes(WAITING))
          : [];
        rows.push({
          id: station.id,
          title: station.title,
          owner: station.owner,
          host: station.host,
          attended: station.attended,
          offers: station.offers,
          cap: station.cap,
          running: running.map(phase),
          waiting: waiting.map((bead) => ({ ...phase(bead), command: `kitchen turn ${bead.id}` })),
        });
      }
      return rows;
    },
  };
}
