// The Pass view's data layer (spec: UI, stories 62, 63, 69): open passes read from bd serve, through the
// expeditor's own port, with a bearer token; the answer posted as the close of the gate with the word
// as its reason and the human's name as the actor. The UI holds the token and the name, never the
// SQL credential. A station or the expeditor is refused before any request, the same cooperative rule
// the bd wrapper and the CLI apply (docs/trust-model.md). No DOM here: the view is tested at this seam.
import { parseActor, RULE } from "../src/actor.ts";
import { client, ViewError } from "./client.ts";
import type { ClientDeps, Problem } from "./client.ts";

/** One open pass as the view lists it. */
export interface Pass {
  id: string;
  title: string;
  /** What the station wrote for the human: the reason of the gate. */
  brief: string;
  /** The order the pass belongs to; its title is undefined when bd serve cannot show the order. */
  order: { id: string; title: string | undefined };
  /** Who laid the pass: the station's actor, or the expeditor on a pass Kitchen laid. */
  laidBy: string | undefined;
  laidAt: string | undefined;
}

export interface PassView {
  list(): Promise<Pass[]>;
  /** Closes the pass with the word as its reason, under the actor. */
  answer(pass: Pick<Pass, "id">, word: string): Promise<void>;
}

export interface PassViewDeps extends ClientDeps {
  /** The human's name: what the close is written as. */
  actor: string;
}

/** A gate bead as bd serve lists it; only the fields the view reads are named. */
interface GateRow {
  id: string;
  title: string;
  issue_type: string;
  await_type?: string;
  description?: string;
  parent?: string;
  created_by?: string;
  created_at?: string;
}

const REASON = /\n\nReason: ([\s\S]*)$/;

export function passView(deps: PassViewDeps): PassView {
  const api = client(deps);

  const orderOf = async (id: string | undefined): Promise<Pass["order"]> => {
    if (id === undefined) return { id: "", title: undefined };
    const { status, body } = await api.get<GateRow & Problem>(`/v0/beads/issues/${id}`);
    if (status === 401) throw api.refused(status, body, "the order");
    return { id, title: status === 200 ? body.title : undefined };
  };

  return {
    list: async () => {
      const rows = await api.list<GateRow>("/v0/beads/issues?type=gate&status=open&limit=0", "the list of passes");
      const passes: Pass[] = [];
      for (const row of rows.filter((gate) => gate.await_type === "human")) {
        passes.push({
          id: row.id,
          title: row.title,
          brief: REASON.exec(row.description ?? "")?.[1] ?? row.description ?? "",
          order: await orderOf(row.parent),
          laidBy: row.created_by,
          laidAt: row.created_at,
        });
      }
      return passes;
    },

    answer: async (pass, word) => {
      const reason = word.trim();
      if (reason === "") throw new ViewError("the word is empty: a pass closes with the human's word as its reason");
      if (parseActor(deps.actor).kind !== "human") {
        throw new ViewError(`${deps.actor} may not close the pass ${pass.id}: a pass closes only under a person's name (${RULE})`);
      }
      const { status, body } = await api.post(`/v0/beads/issues/${pass.id}:close`, { actor: deps.actor, reason });
      if (status !== 200) throw api.refused(status, body, `the close of ${pass.id}`);
    },
  };
}
