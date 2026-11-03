// The pass: a human gate bead, child of its order, holding the brief a station wrote (spec: Store).
// Read back from a bead as `bd list --type gate` prints it, for `kitchen pass` to show and close and
// for `kitchen status` to count. A pass closes with the human's word as its reason, which only the
// space wrapper writes, under a person's name.
import { LOOP } from "./order.ts";
import { parseOrder } from "./order.ts";
import type { Order } from "./order.ts";
import type { Bead, BeadRef, Space } from "./space.ts";

export interface Pass {
  id: string;
  title: string;
  /** The order it is a child of; a gate laid without the second write that parents it has none. */
  order?: string;
  /** The brief: the reason the gate was laid with. A pass without one is open but not briefed. */
  brief?: string;
  /** The person it is for. */
  assignee?: string;
  labels: string[];
  /** The bead as read, for the close. */
  ref: BeadRef;
}

/** A bead that is not a pass; the message names what it is. */
export class PassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassError";
  }
}

/** bd writes a gate's reason into its description after this line. */
const REASON = /(?:^|\n)Reason: ([\s\S]*)$/;

/** The brief a gate's description holds, if it was laid with a reason. */
export function briefOf(description: string | undefined): string | undefined {
  const brief = REASON.exec(description ?? "")?.[1]?.trim();
  return brief ? brief : undefined;
}

/** The pass a bead holds, as `bd list` or `bd show` printed it. */
export function parsePass(bead: Bead): Pass {
  if (bead.issue_type !== "gate") throw new PassError(`${bead.id} is a ${bead.issue_type} bead, not a pass`);
  if (bead.await_type !== "human") throw new PassError(`${bead.id} is a ${bead.await_type ?? "typed"} gate, an external wait, not a pass`);
  const pass: Pass = {
    id: bead.id,
    title: bead.title,
    labels: [...(bead.labels ?? [])],
    ref: { id: bead.id, issue_type: bead.issue_type, await_type: bead.await_type },
  };
  if (typeof bead.parent === "string" && bead.parent !== "") pass.order = bead.parent;
  const brief = briefOf(bead.description);
  if (brief !== undefined) pass.brief = brief;
  if (typeof bead.assignee === "string" && bead.assignee !== "") pass.assignee = bead.assignee;
  return pass;
}

/** The open passes: the open gates of type human, as bd lists them. */
export async function readPasses(space: Space): Promise<Pass[]> {
  const beads = await space.list({ type: "gate", status: "open" });
  return beads.filter((bead) => bead.await_type === "human").map(parsePass);
}

/** The open orders by id, for naming the order a pass or a phase belongs to. */
export async function readOrders(space: Space): Promise<Map<string, Order>> {
  const beads = await space.list({ type: "epic", labels: [LOOP] });
  return new Map(beads.map((bead) => [bead.id, parseOrder(bead)]));
}

/** `kitchen-20 (Stale cookie)`, or the id alone when the order is not among the open ones. */
export function nameOrder(id: string | undefined, orders: Map<string, Order>): string {
  if (id === undefined) return "no order";
  const order = orders.get(id);
  return order ? `${id} (${order.title})` : id;
}
