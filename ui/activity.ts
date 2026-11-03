// The Activity view's data layer (spec: UI, story 68): the latest records of the events journal, read
// from bd serve's events route and listed newest first, so what changed while the human was away is
// one page. The route reads forward from a sequence number, so the view asks for the head first and
// then for the records behind it. Reads only. No DOM here.
import { client } from "./client.ts";
import type { ClientDeps } from "./client.ts";

/** One journal record as the view lists it. */
export interface JournalEntry {
  seq: number;
  at: string;
  actor: string;
  /** What was done: `create`, `update`, `close`, `dep_add`, as the journal names it. */
  op: string;
  /** The bead it was done to. */
  bead: string;
  title: string;
  /** What the record carries beyond the op: the close reason, the dependency, or the bead's status and station. */
  detail: string;
}

export interface ActivityView {
  /** The latest records, newest first; 50 when no count is given. */
  latest(count?: number): Promise<JournalEntry[]>;
}

/** A record as bd serve's events route answers it; only the fields the view reads are named. */
interface JournalRecord {
  seq: number;
  ts: string;
  op: string;
  issue_id: string;
  actor: string;
  issue?: { title?: string; status?: string; assignee?: string; close_reason?: string };
  dep?: { kind: string; target: string };
}

interface Journal {
  head: number;
  records: JournalRecord[];
}

const DEFAULT_COUNT = 50;

function detailOf(record: JournalRecord): string {
  if (record.dep) return `${record.dep.kind} ${record.dep.target}`;
  if (record.op === "close") return record.issue?.close_reason ?? "";
  const status = record.issue?.status ?? "";
  return record.issue?.assignee ? `${status}, at ${record.issue.assignee}` : status;
}

export function activityView(deps: ClientDeps): ActivityView {
  const api = client(deps);
  const read = async (query: string): Promise<Journal> => {
    const { status, body } = await api.get<Journal & { detail?: string; code?: string }>(`/v0/beads/events?${query}`);
    if (status !== 200) throw api.refused(status, body, "the events journal");
    return body;
  };
  return {
    latest: async (count = DEFAULT_COUNT) => {
      const { head } = await read("since=0&limit=1");
      if (head === 0) return [];
      const { records } = await read(`since=${Math.max(0, head - count)}&limit=${count}`);
      return records
        .map((record) => ({ seq: record.seq, at: record.ts, actor: record.actor, op: record.op, bead: record.issue_id, title: record.issue?.title ?? "", detail: detailOf(record) }))
        .sort((a, b) => b.seq - a.seq);
    },
  };
}
