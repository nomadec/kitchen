// Starting and ending one turn: the take on the order and the claim on the phase, both under the
// station actor because beads requires them from the holder, the order's worktrees between them, then
// the runner; at the end, the result line commented on the phase as the expeditor and the order
// released by the station. The expeditor's dispatch and a foreground `kitchen turn` share these two
// functions.
import type { LaidPhase } from "../laid.ts";
import { parseOrder } from "../order.ts";
import type { Order } from "../order.ts";
import type { CommandRunner } from "../runner.ts";
import { SpaceError } from "../space.ts";
import type { Space } from "../space.ts";
import { offeredCheckouts } from "../station.ts";
import type { Station } from "../station.ts";
import type { TurnHandle, TurnMode, TurnRunner } from "./claude.ts";
import { ensureWorktree, PER_ORDER, WorktreeError } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

export interface Turn {
  phase: LaidPhase;
  station: Station;
  order: Order;
  mode: TurnMode;
  /** The order's worktrees in this station's checkouts, in the order the order names its repositories. */
  worktrees: Worktree[];
  handle: TurnHandle;
}

export type TurnStart =
  | { kind: "started"; turn: Turn }
  /** The order is held by another turn: its take refused the station, naming the holder. */
  | { kind: "held"; by: string }
  /** The phase was claimed first by another expeditor; the take is released again. */
  | { kind: "claimed"; by: string }
  /** A worktree could not be prepared, git saying why; the take is released again. */
  | { kind: "unprepared"; reason: string };

export interface TurnEnd {
  /** The last line of the session's standard output, or the exit code when it printed nothing. */
  resultLine: string;
  exitCode: number;
}

export interface StartTurnDeps {
  /** The space under the station actor: the take and the claim are written as the holder. */
  station: Space;
  runner: TurnRunner;
  /** The command runner the worktrees' git calls go through. */
  git: CommandRunner;
}

/** Takes the order, prepares its worktrees, claims the phase and spawns the runner; stops at the first refusal. */
export async function startTurn(deps: StartTurnDeps, station: Station, phase: LaidPhase, mode: TurnMode): Promise<TurnStart> {
  const order = { id: phase.order, issue_type: "epic" };
  let taken;
  try {
    taken = await deps.station.claim(order);
  } catch (error) {
    const holder = claimedBy(error);
    if (holder) return { kind: "held", by: holder };
    throw error;
  }
  const parsed = parseOrder(taken);
  let worktrees: Worktree[];
  try {
    worktrees = await prepareWorktrees(deps.git, station, parsed);
  } catch (error) {
    if (!(error instanceof WorktreeError)) throw error;
    await deps.station.release(order);
    return { kind: "unprepared", reason: error.message };
  }
  try {
    await deps.station.claim({ id: phase.id, issue_type: "task" });
  } catch (error) {
    const holder = claimedBy(error);
    if (!holder) throw error;
    await deps.station.release(order);
    return { kind: "claimed", by: holder };
  }
  const handle = deps.runner({ launch: station.launch, phase, mode, order: parsed, worktrees });
  return { kind: "started", turn: { phase, station, order: parsed, mode, worktrees, handle } };
}

/**
 * A phase touches code when its order names repositories; under the per-order policy each one the
 * station offers gets the order's worktree in that checkout, created or reused. Any other policy, or
 * an order naming no repository, leaves the runner in the station's checkout.
 */
async function prepareWorktrees(git: CommandRunner, station: Station, order: Order): Promise<Worktree[]> {
  if (station.launch.worktrees !== PER_ORDER) return [];
  const worktrees: Worktree[] = [];
  for (const checkout of offeredCheckouts(station.launch, order.repos)) {
    worktrees.push(await ensureWorktree(git, checkout, order.id, station));
  }
  return worktrees;
}

export interface EndTurnDeps {
  /** The space under the expeditor actor: the result line is its comment. */
  expeditor: Space;
  station: Space;
}

/** Waits for the session, comments its result line on the phase and releases the order. */
export async function endTurn(deps: EndTurnDeps, turn: Turn): Promise<TurnEnd> {
  const result = await turn.handle.done;
  const resultLine = lastLine(result.stdout) ?? `exit ${result.exitCode}`;
  await deps.expeditor.comment(turn.phase.id, resultLine);
  await deps.station.release({ id: turn.order.id, issue_type: "epic" });
  return { resultLine, exitCode: result.exitCode };
}

/** The holder named by bd's refusal of a claim, when the error is that. */
function claimedBy(error: unknown): string | undefined {
  if (!(error instanceof SpaceError)) return undefined;
  return /already claimed by (\S+)/.exec(error.result.stderr)?.[1];
}

function lastLine(stdout: string): string | undefined {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
}
