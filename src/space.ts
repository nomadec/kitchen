// The one door to the space: every bd call Kitchen makes is built here, under one actor, over the
// connection kitchen init wrote from the host config (the beads workspace and the credential file).
// Thin argv builders over bd 1.3.1; the refusals are the cooperative rules of docs/trust-model.md,
// judged before any call is issued.
import { actorName } from "./actor.ts";
import type { Actor } from "./actor.ts";
import { spaceDir } from "./config.ts";
import type { HostConfig } from "./config.ts";
import { noteLine, withNoteLine } from "./fields.ts";
import type { CommandResult, CommandRunner } from "./runner.ts";

/** A bead as bd prints it with --json; only the fields Kitchen reads are named. */
export interface Bead {
  id: string;
  title: string;
  status: string;
  issue_type: string;
  await_type?: string;
  labels?: string[];
  notes?: string;
  description?: string;
  [field: string]: unknown;
}

/** What an edit or a close needs to know about its target: the bead as it was read. */
export type BeadRef = Pick<Bead, "id" | "issue_type"> & Partial<Pick<Bead, "await_type">>;

/** The bead types only a person registers (story 33). */
export const REGISTERED_TYPES: readonly string[] = ["phase", "station", "source"];

/** `human` is a pass; the rest are external waits `bd gate check` evaluates. */
export type GateType = "human" | "timer" | "gh:pr" | "gh:run" | "bead";

export interface SpaceDeps {
  runner: CommandRunner;
  env: Record<string, string | undefined>;
  config: HostConfig;
  actor: Actor;
}

export interface CreateFields {
  title: string;
  type?: string;
  parent?: string;
  labels?: readonly string[];
  notes?: string;
  description?: string;
  assignee?: string;
  externalRef?: string;
  /** Beads this one is blocked by. */
  blockedBy?: readonly string[];
}

export interface UpdateFields {
  title?: string;
  description?: string;
  /** Reparents the bead: a gate, which `bd gate create` cannot parent, becomes a child of its order this way. */
  parent?: string;
  /** Replaces the notes field whole; see setNote for one line of it. */
  notes?: string;
  appendNotes?: string;
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
  assignee?: string;
  status?: string;
}

/** What `bd ready` and `bd list` narrow by. */
export interface BeadFilter {
  assignee?: string;
  /** Every label must be present. */
  labels?: readonly string[];
  type?: string;
  parent?: string;
  /** The stored status: `open`, `in_progress`, `blocked`, `deferred`, `closed`. */
  status?: string;
  /** The exact external reference, or a substring of it: the two duplicate checks of intake. */
  externalRef?: string;
  externalContains?: string;
}

export type ReadyFilter = BeadFilter;
/** The name the recipe slice gave the list filter; the same type. */
export type ListFilter = BeadFilter;

export interface GateFields {
  /** The bead the gate blocks: the phase laid behind a pass, or behind an external wait. */
  blocks: string;
  type: GateType;
  title?: string;
  /** The brief of a pass, or what an external wait is for. */
  reason?: string;
  awaitId?: string;
  timeout?: string;
}

/** One row of the events journal, as `bd events tail` prints it; only `seq` is named. */
export interface JournalEvent {
  seq: number;
  [field: string]: unknown;
}

/** A bd call that exited non-zero. */
export class SpaceError extends Error {
  readonly argv: readonly string[];
  readonly result: CommandResult;
  constructor(argv: readonly string[], result: CommandResult) {
    super(`${argv.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    this.name = "SpaceError";
    this.argv = argv;
    this.result = result;
  }
}

/** A write the cooperative rules refuse under this actor. No bd write was issued. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

export interface Space {
  readonly actor: Actor;
  create(fields: CreateFields): Promise<Bead>;
  update(bead: BeadRef, fields: UpdateFields): Promise<void>;
  /** Makes `id` blocked by `blockedBy`. */
  addDependency(id: string, blockedBy: string): Promise<void>;
  /** Open beads with no active blocker, as `bd ready` lists them. */
  ready(filter?: ReadyFilter): Promise<Bead[]>;
  /** Open beads matching the filter, as `bd list` prints them. */
  list(filter?: BeadFilter): Promise<Bead[]>;
  show(id: string): Promise<Bead>;
  /** The value of the `<key>: <value>` line of the bead's notes, if there is one. */
  readNote(id: string, key: string): Promise<string | undefined>;
  /** Sets the `<key>: <value>` line of the bead's notes, replacing an earlier one or appending. */
  setNote(bead: BeadRef, key: string, value: string): Promise<void>;
  close(bead: BeadRef, reason: string): Promise<void>;
  /** Lays a gate bead that blocks another bead: a pass when its type is `human`. */
  layGate(fields: GateFields): Promise<Bead>;
  /** The open gate beads. */
  gates(): Promise<Bead[]>;
  /** Evaluates the typed gates (all of them, or one type) and closes those that resolved. */
  checkGates(type?: GateType): Promise<void>;
  /** The events journal after a sequence number. */
  events(since: number): Promise<JournalEvent[]>;
}

/** The pointer every refusal ends with. */
export const RULE = "a cooperative rule, not a security boundary: docs/trust-model.md";

export function openSpace(deps: SpaceDeps): Space {
  const name = actorName(deps.actor);
  const station = deps.actor.kind === "station";
  const person = deps.actor.kind === "human";
  const connection = { cwd: spaceDir(deps.env), env: { BEADS_CREDENTIALS_FILE: deps.config.credential } };

  async function bd(args: readonly string[]): Promise<CommandResult> {
    const argv = ["bd", "--actor", name, ...args];
    const result = await deps.runner(argv, connection);
    if (result.exitCode !== 0) throw new SpaceError(argv, result);
    return result;
  }

  async function bdJson<T>(args: readonly string[]): Promise<T> {
    return JSON.parse((await bd([...args, "--json"])).stdout) as T;
  }

  /** Registration is a human act; a station is refused. The expeditor keeps a source's cursor, so it is not. */
  function refuseRegistered(verb: "create" | "edit", type: string | undefined): void {
    if (station && type !== undefined && REGISTERED_TYPES.includes(type)) {
      throw new RefusedError(
        `${name} may not ${verb} a ${type} bead: registering recipes, stations and sources is a human act (${RULE})`,
      );
    }
  }

  /** A pass closes only under a person's name; a gate whose type the caller did not read is read first. */
  async function refusePassClose(bead: BeadRef): Promise<void> {
    if (person || bead.issue_type !== "gate") return;
    const awaitType = bead.await_type ?? (await show(bead.id)).await_type;
    if (awaitType === "human") {
      throw new RefusedError(`${name} may not close the pass ${bead.id}: a pass closes only under a person's name (${RULE})`);
    }
  }

  const show = async (id: string): Promise<Bead> => {
    const [bead] = await bdJson<Bead[]>(["show", id]);
    if (!bead) throw new Error(`bd show ${id} answered with no bead`);
    return bead;
  };

  const update = async (bead: BeadRef, fields: UpdateFields): Promise<void> => {
    refuseRegistered("edit", bead.issue_type);
    await bdJson<unknown>([
      "update", bead.id,
      ...flag("--title", fields.title),
      ...flag("--description", fields.description),
      ...flag("--parent", fields.parent),
      ...flag("--notes", fields.notes),
      ...flag("--append-notes", fields.appendNotes),
      ...each("--add-label", fields.addLabels),
      ...each("--remove-label", fields.removeLabels),
      ...flag("--assignee", fields.assignee),
      ...flag("--status", fields.status),
    ]);
  };

  return {
    actor: deps.actor,

    create: async (fields) => {
      refuseRegistered("create", fields.type);
      return bdJson<Bead>([
        "create", fields.title,
        ...flag("--type", fields.type),
        // A child carries the labels it is given, not its parent's: a laid phase is not `loop`.
        ...(fields.parent ? ["--parent", fields.parent, "--no-inherit-labels"] : []),
        ...flag("--labels", fields.labels?.join(",")),
        ...flag("--notes", fields.notes),
        ...flag("--description", fields.description),
        ...flag("--assignee", fields.assignee),
        ...flag("--external-ref", fields.externalRef),
        ...flag("--deps", fields.blockedBy?.map((id) => `blocked-by:${id}`).join(",")),
      ]);
    },

    update,

    addDependency: async (id, blockedBy) => {
      await bd(["dep", "add", id, blockedBy]);
    },

    ready: (filter = {}) =>
      bdJson<Bead[]>([
        "ready",
        ...flag("--assignee", filter.assignee),
        ...each("--label", filter.labels),
        ...flag("--type", filter.type),
        ...flag("--parent", filter.parent),
        "--limit", "0",
      ]),

    list: (filter = {}) =>
      bdJson<Bead[]>([
        "list",
        ...flag("--type", filter.type),
        ...each("--label", filter.labels),
        ...flag("--assignee", filter.assignee),
        ...flag("--parent", filter.parent),
        ...flag("--status", filter.status),
        ...flag("--external-ref", filter.externalRef),
        ...flag("--external-contains", filter.externalContains),
        "--limit", "0",
      ]),

    show,

    readNote: async (id, key) => noteLine((await show(id)).notes ?? "", key),

    setNote: async (bead, key, value) => {
      refuseRegistered("edit", bead.issue_type);
      const current = (await show(bead.id)).notes ?? "";
      await update(bead, { notes: withNoteLine(current, key, value) });
    },

    close: async (bead, reason) => {
      await refusePassClose(bead);
      await bdJson<unknown>(["close", bead.id, "--reason", reason]);
    },

    layGate: (fields) =>
      bdJson<Bead>([
        "gate", "create",
        "--type", fields.type,
        "--blocks", fields.blocks,
        ...flag("--title", fields.title),
        ...flag("--reason", fields.reason),
        ...flag("--await-id", fields.awaitId),
        ...flag("--timeout", fields.timeout),
      ]),

    gates: () => bdJson<Bead[]>(["gate", "list", "--limit", "0"]),

    checkGates: async (type) => {
      await bdJson<unknown>(["gate", "check", ...flag("--type", type)]);
    },

    events: async (since) => {
      const { stdout } = await bd(["events", "tail", "--since", String(since)]);
      return stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as JournalEvent);
    },
  };
}

function flag(name: string, value: string | undefined): string[] {
  return value === undefined || value === "" ? [] : [name, value];
}

function each(name: string, values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => [name, value]);
}
