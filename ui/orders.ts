// The Orders view's data layer (spec: UI, story 66): every open order read from bd serve, and the
// orders closed last, grouped by status, each with its class, the recipe revision it pinned and the
// phases it is at now, read from its open children. Reads only. No DOM here: the view is tested at
// this seam.
import { labelValue } from "../src/fields.ts";
import { WAITING } from "../src/laid.ts";
import { parseOrder } from "../src/order.ts";
import type { Bead } from "../src/space.ts";
import { client } from "./client.ts";
import type { ClientDeps } from "./client.ts";

/** What a laid phase is at: worked in a turn, waiting for `kitchen turn` at an attended station, or laid and not started. */
export type PhaseState = "in progress" | "waiting" | "laid";

/** One open phase of an order, as the view shows where the order is. */
export interface CurrentPhase {
  id: string;
  slug: string;
  state: PhaseState;
  /** The station it is assigned to. */
  station: string;
}

export interface OrderRow {
  id: string;
  title: string;
  status: string;
  class: string | undefined;
  recipe: string | undefined;
  /** The `rev:<revision>` the order pinned at intake, or when it crossed into another recipe. */
  revision: string | undefined;
  externalRef: string | undefined;
  /** The phases in progress first, then the ones laid; none for an order between phases or closed. */
  phases: CurrentPhase[];
}

export interface OrderGroup {
  status: string;
  orders: OrderRow[];
}

export interface OrdersView {
  /** The orders grouped by status, in the order in progress, open, blocked, deferred, closed; empty groups left out. */
  list(): Promise<OrderGroup[]>;
}

/** The order the groups come in: what runs, what waits, what is parked, what is done. */
const STATUSES = ["in_progress", "open", "blocked", "deferred", "closed"] as const;

/** How many closed orders the view shows: the ones closed last, so a long-lived space stays one page. */
const CLOSED_SHOWN = 20;

const RANK: Record<PhaseState, number> = { "in progress": 0, waiting: 1, laid: 2 };

function stateOf(bead: Bead): PhaseState {
  if (bead.status === "in_progress") return "in progress";
  return bead.labels?.includes(WAITING) ? "waiting" : "laid";
}

/** The open phases among an order's children: the beads with a `phase:` label, in progress first. */
function currentPhases(children: readonly Bead[]): CurrentPhase[] {
  return children
    .flatMap((bead) => {
      const slug = labelValue(bead, "phase");
      return slug === undefined ? [] : [{ id: bead.id, slug, state: stateOf(bead), station: typeof bead.assignee === "string" ? bead.assignee : "" }];
    })
    .sort((a, b) => RANK[a.state] - RANK[b.state] || a.id.localeCompare(b.id));
}

export function ordersView(deps: ClientDeps): OrdersView {
  const api = client(deps);
  return {
    list: async () => {
      const beads = [
        ...(await api.list<Bead>("/v0/beads/issues?type=epic&label=loop&limit=0", "the list of orders")),
        ...(await api.list<Bead>(`/v0/beads/issues?type=epic&label=loop&status=closed&limit=${CLOSED_SHOWN}`, "the orders closed last")),
      ];
      const rows: OrderRow[] = [];
      for (const bead of beads) {
        const order = parseOrder(bead);
        const children = bead.status === "closed" ? [] : await api.list<Bead>(`/v0/beads/issues?parent=${bead.id}&limit=0`, `the phases of ${bead.id}`);
        rows.push({
          id: order.id,
          title: order.title,
          status: order.status,
          class: order.class,
          recipe: order.recipe,
          revision: order.revision,
          externalRef: order.externalRef,
          phases: currentPhases(children),
        });
      }
      const known: readonly string[] = STATUSES;
      const statuses = [...STATUSES, ...rows.map((r) => r.status).filter((s) => !known.includes(s))];
      return statuses
        .map((status) => ({ status, orders: rows.filter((row) => row.status === status).sort((a, b) => a.id.localeCompare(b.id)) }))
        .filter((group) => group.orders.length > 0);
    },
  };
}
