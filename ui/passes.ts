// The Pass view's data layer (spec: UI, stories 62, 63, 69): open passes read from bd serve, through the
// expeditor's own port, with a bearer token; the answer posted as the close of the gate with the word
// as its reason and the human's name as the actor. The UI holds the token and the name, never the
// SQL credential. A station or the expeditor is refused before any request, the same cooperative rule
// the bd wrapper and the CLI apply (docs/trust-model.md). No DOM here: the view is tested at this seam.
import { parseActor, RULE } from "../src/actor.ts";

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

export interface PassViewDeps {
  fetch: typeof fetch;
  /** The bearer token from the expeditor's token file. */
  token: string;
  /** The human's name: what the close is written as. */
  actor: string;
  /** The origin bd serve is reached through; the page's own when left out. */
  base?: string;
}

/** A refusal, by the view itself (no request made) or by bd serve (its status and detail). */
export class PassViewError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "PassViewError";
    this.status = status;
  }
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

interface Problem {
  detail?: string;
  code?: string;
}

const REASON = /\n\nReason: ([\s\S]*)$/;

export function passView(deps: PassViewDeps): PassView {
  const base = deps.base ?? "";
  const headers = { authorization: `Bearer ${deps.token}` };

  async function get<T>(path: string): Promise<{ status: number; body: T }> {
    const response = await deps.fetch(`${base}${path}`, { headers });
    return { status: response.status, body: (await response.json()) as T };
  }

  const refused = (status: number, body: Problem, what: string): PassViewError =>
    status === 401
      ? new PassViewError(`the token was refused: ${body.detail ?? "missing or invalid bearer token"}`, status)
      : new PassViewError(`bd serve refused ${what}: ${body.detail ?? body.code ?? `status ${status}`}`, status);

  const orderOf = async (id: string | undefined): Promise<Pass["order"]> => {
    if (id === undefined) return { id: "", title: undefined };
    const { status, body } = await get<GateRow & Problem>(`/v0/beads/issues/${id}`);
    if (status === 401) throw refused(status, body, "the order");
    return { id, title: status === 200 ? body.title : undefined };
  };

  return {
    list: async () => {
      const { status, body } = await get<{ items: GateRow[] } & Problem>("/v0/beads/issues?type=gate&status=open&limit=0");
      if (status !== 200) throw refused(status, body, "the list of passes");
      const passes: Pass[] = [];
      for (const row of body.items.filter((gate) => gate.await_type === "human")) {
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
      if (reason === "") throw new PassViewError("the word is empty: a pass closes with the human's word as its reason");
      if (parseActor(deps.actor).kind !== "human") {
        throw new PassViewError(`${deps.actor} may not close the pass ${pass.id}: a pass closes only under a person's name (${RULE})`);
      }
      const response = await deps.fetch(`${base}/v0/beads/issues/${pass.id}:close`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ actor: deps.actor, reason }),
      });
      if (response.status !== 200) throw refused(response.status, (await response.json()) as Problem, `the close of ${pass.id}`);
    },
  };
}
