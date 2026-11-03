// The source: where orders come from, registered as a bead of type `source` and polled by one host's
// expeditor since the cursor on the bead. Both directions live here: the bead a registration makes,
// and the source read back from a bead.
import { labelValue, noteLine } from "./fields.ts";
import type { Bead, CreateFields } from "./space.ts";

export const SOURCE_KINDS = ["github", "file"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What an order currently is; a polled source gives the class its items enter with. */
export const CLASSES = ["unsorted", "question", "idea", "proposal", "spec", "ticket", "bug"] as const;
export type OrderClass = (typeof CLASSES)[number];

export interface SourceFields {
  owner: string;
  /** The one host that polls it. */
  host: string;
  kind: SourceKind;
  /** A repository slug for `github`, a JSONL path for `file`. */
  target: string;
  recipe: string;
  class: OrderClass;
  /** Where the first poll starts: the registration instant for `github`, so the space starts without old work; empty for `file`. */
  cursor: string;
}

export interface Source extends SourceFields {
  id: string;
  title: string;
  /** Where the last poll ended: an issue cursor or a JSONL offset; empty before the first poll. */
  cursor: string;
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export function isSourceKind(value: string): value is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(value);
}

export function isOrderClass(value: string): value is OrderClass {
  return (CLASSES as readonly string[]).includes(value);
}

/** The `bd create` fields of a source bead. */
export function sourceFields(source: SourceFields): CreateFields {
  return {
    title: `${source.kind}:${source.target}`,
    type: "source",
    labels: [`owner:${source.owner}`, `host:${source.host}`, `kind:${source.kind}`],
    notes: [`target: ${source.target}`, `recipe: ${source.recipe}`, `class: ${source.class}`, `cursor: ${source.cursor}`.trimEnd()].join("\n"),
  };
}

/** The source a bead holds, as `bd show` or `bd list` printed it. */
export function parseSource(bead: Bead): Source {
  if (bead.issue_type !== "source") throw new SourceError(`${bead.id} is a ${bead.issue_type} bead, not a source`);
  const label = (key: string): string => {
    const value = labelValue(bead, key);
    if (value === undefined) throw new SourceError(`${bead.id} carries no ${key}: label`);
    return value;
  };
  const note = (key: string): string => {
    const value = noteLine(bead.notes ?? "", key);
    if (value === undefined) throw new SourceError(`${bead.id} carries no ${key}: note`);
    return value;
  };
  const kind = label("kind");
  if (!isSourceKind(kind)) throw new SourceError(`${bead.id} is of kind ${kind}, not github or file`);
  const cls = note("class");
  if (!isOrderClass(cls)) throw new SourceError(`${bead.id} enters its items as ${cls}, not a class`);
  return {
    id: bead.id,
    title: bead.title,
    owner: label("owner"),
    host: label("host"),
    kind,
    target: note("target"),
    recipe: note("recipe"),
    class: cls,
    cursor: note("cursor"),
  };
}
