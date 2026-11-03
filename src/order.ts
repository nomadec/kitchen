// The order: one unit of work from a source to its outcome, held as an epic bead with the `loop`
// label (spec: Store). Both directions live here: the bead intake creates, and the order read back
// from a bead for printing and for the views.
import { noteLine } from "./fields.ts";
import type { OrderClass } from "./source.ts";
import { isOrderClass } from "./source.ts";
import type { Bead, CreateFields } from "./space.ts";

/** The label every order carries; the duplicate check narrows by it. */
export const LOOP = "loop";

/** What a source gives intake: enough to make the order bead and to check it is not there already. */
export interface OrderSource {
  title: string;
  /** The external reference the bead carries: the issue URL, `file:<path>` or `text:<sentence>`. */
  externalRef: string;
  /** The substring of the reference a second order would share: `owner/repo/issues/n`, the path stem, the sentence. */
  externalContains: string;
  /** The source's text in full: the issue body, the file, the sentence. The order's description. */
  text: string;
}

export interface OrderFields {
  source: OrderSource;
  /** Remote slugs, in the order given. */
  repos: readonly string[];
  recipe: string;
  /** The `rev:<revision>` label of the recipe's latest revision at intake. */
  revision: string;
  class: OrderClass;
}

export interface Order {
  id: string;
  title: string;
  status: string;
  externalRef?: string;
  repos: string[];
  recipe?: string;
  revision?: string;
  class?: OrderClass;
}

/** The `bd create` fields of an order bead. */
export function orderFields(fields: OrderFields): CreateFields {
  return {
    title: fields.source.title,
    type: "epic",
    labels: [LOOP],
    notes: [`repos: ${fields.repos.join(", ")}`, `recipe: ${fields.recipe} ${fields.revision}`, `class: ${fields.class}`].join("\n"),
    description: fields.source.text,
    externalRef: fields.source.externalRef,
  };
}

/** The order a bead holds, as `bd list` or `bd show` printed it; a note it lacks leaves the field unset. */
export function parseOrder(bead: Bead): Order {
  const notes = bead.notes ?? "";
  const order: Order = {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    repos: (noteLine(notes, "repos") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  if (typeof bead.external_ref === "string" && bead.external_ref !== "") order.externalRef = bead.external_ref;
  const recipe = noteLine(notes, "recipe");
  if (recipe) {
    const [name, revision] = recipe.split(/\s+/);
    if (name) order.recipe = name;
    if (revision) order.revision = revision;
  }
  const cls = noteLine(notes, "class");
  if (cls && isOrderClass(cls)) order.class = cls;
  return order;
}

/** One line per order, as `order add` prints an order that exists already. */
export function describeOrder(order: Order): string {
  const facts = [order.status, order.class, order.recipe && `${order.recipe} ${order.revision ?? ""}`.trim()].filter(Boolean);
  return `${order.id} ${order.title} (${facts.join(", ")})${order.externalRef ? ` from ${order.externalRef}` : ""}`;
}
