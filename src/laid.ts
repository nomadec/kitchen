// A laid phase: the child task bead of an order that a turn works (spec: Store). Read back from a bead
// as `bd ready` lists it, for the expeditor to start and for `kitchen turn` and `kitchen status` to show.
import { labelValue, noteLine } from "./fields.ts";
import { parsePhaseFile, PhaseError } from "./recipe/phase.ts";
import type { Budget } from "./recipe/phase.ts";
import type { Bead } from "./space.ts";

/** The label the expeditor puts on a ready phase of an attended station: it waits for `kitchen turn`. */
export const WAITING = "waiting";

export interface LaidPhase {
  id: string;
  title: string;
  /** The order it is a child of. */
  order: string;
  /** The station it is assigned to: the station title, which is its turn actor. */
  station: string;
  /** The registered phase it was laid from: the `phase:<slug>` label. */
  slug: string;
  skill: string;
  /** The model resolved at lay time, written on the bead. */
  model: string;
  /** The dollar cap and the effort the runner maps to harness flags. */
  budget: Budget;
  labels: string[];
}

/** A bead that cannot be a laid phase; the message names what is missing. */
export class LaidPhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaidPhaseError";
  }
}

/** The laid phase a bead holds, as `bd ready` or `bd show` printed it. */
export function parseLaidPhase(bead: Bead): LaidPhase {
  const slug = labelValue(bead, "phase");
  if (slug === undefined) throw new LaidPhaseError(`${bead.id} carries no phase: label`);
  const order = bead.parent;
  if (typeof order !== "string" || order === "") throw new LaidPhaseError(`${bead.id} has no parent order`);
  const station = bead.assignee;
  if (typeof station !== "string" || station === "") throw new LaidPhaseError(`${bead.id} is assigned to no station`);
  let registered;
  try {
    registered = parsePhaseFile(typeof bead.description === "string" ? bead.description : "", `${slug}.md`);
  } catch (error) {
    if (error instanceof PhaseError) throw new LaidPhaseError(`${bead.id} does not hold the phase it was laid from: ${error.message}`);
    throw error;
  }
  const model = noteLine(bead.notes ?? "", "model") || registered.model;
  if (!model) throw new LaidPhaseError(`${bead.id} carries no model: note and ${slug} names none`);
  if (!registered.budget) throw new LaidPhaseError(`${bead.id} was laid from ${slug}, which has no budget`);
  return {
    id: bead.id,
    title: bead.title,
    order,
    station,
    slug,
    skill: registered.skill,
    model,
    budget: registered.budget,
    labels: [...(bead.labels ?? [])],
  };
}
