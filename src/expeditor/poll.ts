// The source poll, the `sources` step of the tick: every source bead whose owner and host are this
// host's is read since the cursor on the bead, and each new item becomes one order through intake with
// the source's recipe and the class it was registered with. The cursor advances on the bead after each
// order, so the cursor is the whole state of a poll: an interruption between an order and its advance
// lists the item again on the next tick, where the duplicate check, not a second order, answers it.
import fs from "node:fs";
import { intake } from "../intake.ts";
import type { IntakeResult } from "../intake.ts";
import { readItem } from "../item.ts";
import type { Item } from "../item.ts";
import { readSources } from "../registered.ts";
import type { CommandRunner } from "../runner.ts";
import type { Source } from "../source.ts";
import type { Space } from "../space.ts";

/** The issue fields a GitHub poll reads; the class is the source's, so labels are not among them. */
const ISSUE_FIELDS = "number,title,body,url,updatedAt";
/** The most issues one poll lists; the rest come on the next tick, the cursor having advanced. */
const ISSUE_LIMIT = "200";

export interface PollDeps {
  /** The space under the expeditor actor: the reads, the orders and the cursor. */
  space: Space;
  runner: CommandRunner;
  owner: string;
  host: string;
  /** One log line per item and per failure, under the `sources` step. */
  log(fields: Record<string, unknown>): void;
}

export interface PollReport {
  /** The sources polled. */
  sources: string[];
  /** The orders this poll created. */
  orders: string[];
}

/** A poll that could not go on; the message names the source and what failed. */
export class PollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollError";
  }
}

/** One thing a source yields, with the cursor the source stands at once it is behind it. */
type Polled = { cursor: string } & (
  /** An item read already: an issue the list printed. */
  | { item: Item }
  /** An item still to read when its turn comes: what a JSONL line holds. */
  | { target: string }
  /** No item; the cursor still passes it. */
  | { dropped: string }
);

export async function pollSources(deps: PollDeps): Promise<PollReport> {
  const report: PollReport = { sources: [], orders: [] };
  for (const source of await readSources(deps.space, { owner: deps.owner, host: deps.host })) {
    report.sources.push(source.id);
    const bead = { id: source.id, issue_type: "source" };
    let current: string | undefined;
    try {
      for (const polled of await since(deps.runner, source)) {
        if ("dropped" in polled) {
          await deps.space.setNote(bead, "cursor", polled.cursor);
          deps.log({ source: source.id, cursor: polled.cursor, dropped: polled.dropped });
          continue;
        }
        const item = "item" in polled ? polled.item : await readItem(polled.target, deps.runner);
        current = item.source.externalRef;
        const result = await intake(deps.space, { source: item.source, recipe: source.recipe, class: source.class, repos: item.repos, owner: deps.owner });
        if (result.kind !== "existing") report.orders.push(result.order.id);
        await deps.space.setNote(bead, "cursor", polled.cursor);
        deps.log({ source: source.id, item: current, cursor: polled.cursor, ...outcome(result) });
      }
    } catch (error) {
      // The source stops here with its cursor where it was: the next tick lists the same item again.
      deps.log({ source: source.id, ...(current === undefined ? {} : { item: current }), failed: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

function outcome(result: IntakeResult): Record<string, unknown> {
  switch (result.kind) {
    case "existing":
      return { existing: result.orders.map((order) => order.id) };
    case "laid":
      return { order: result.order.id, laid: result.phase.id };
    case "pass":
      return { order: result.order.id, pass: result.pass.id };
  }
}

/** What the source yields since its cursor, oldest first. */
function since(runner: CommandRunner, source: Source): Promise<Polled[]> {
  return source.kind === "github" ? issuesSince(runner, source) : Promise.resolve(linesSince(source));
}

/** What `gh issue list --json` prints of each issue, of the fields the poll asks for. */
interface IssueRow {
  number: number;
  title: string;
  body: string | null;
  url: string;
  updatedAt: string;
}

/**
 * The issues of the target repository updated since the cursor, oldest update first, so the cursor
 * advances through them in order. `>=` rather than `>`: an issue updated in the same second as the
 * cursor is listed again rather than missed, and the duplicate check skips it.
 */
async function issuesSince(runner: CommandRunner, source: Source): Promise<Polled[]> {
  const search = ["sort:updated-asc", ...(source.cursor ? [`updated:>=${source.cursor}`] : [])].join(" ");
  const result = await runner(["gh", "issue", "list", "--repo", source.target, "--state", "all", "--limit", ISSUE_LIMIT, "--search", search, "--json", ISSUE_FIELDS]);
  if (result.exitCode !== 0) throw new PollError(`gh issue list --repo ${source.target} failed: ${result.stderr.trim()}`);
  return (JSON.parse(result.stdout) as IssueRow[]).map((issue) => ({
    cursor: issue.updatedAt,
    item: {
      source: { title: issue.title, externalRef: issue.url, externalContains: `${source.target}/issues/${issue.number}`, text: issue.body ?? "" },
      repos: [source.target],
    },
  }));
}

/**
 * The lines of the JSONL file after the cursor, a line offset counted from zero. Each line is a JSON
 * string holding an item as `kitchen order add` takes it, read when its turn comes; a blank line or
 * one holding anything else is no item and is passed over.
 */
function linesSince(source: Source): Polled[] {
  const offset = source.cursor === "" ? 0 : Number(source.cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new PollError(`${source.id} holds a cursor of ${source.cursor}, not a line offset`);
  const lines = fs.readFileSync(source.target, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(offset).map((line, i) => {
    const cursor = String(offset + i + 1);
    const target = parseLine(line);
    return target === undefined ? { cursor, dropped: `line ${cursor} holds no item: ${line.trim() || "(blank)"}` } : { cursor, target };
  });
}

/** The item a line holds: a JSON string; anything else is no item. */
function parseLine(line: string): string | undefined {
  if (line.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}
