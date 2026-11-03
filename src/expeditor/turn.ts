// Starting and ending one turn: the take on the order and the claim on the phase, both under the
// station actor because beads requires them from the holder, the order's worktrees between them, then
// the runner. While the child lives the station heartbeats both leases on an interval and the station's
// wall-clock timeout kills a child that outlives it. At the end the result line is commented on the
// phase as the expeditor; a phase the child left open is released by the station and restored by the
// expeditor to the station its `station:` label names, a failed turn counted on it as `failed:<n>`,
// and the second failure lays the `turn failed` pass for the owner. The order is released by the
// station on every path. The expeditor's dispatch and a foreground `kitchen turn` share these two
// functions.
import { durationMs, sleptOut } from "../clock.ts";
import type { Clock } from "../clock.ts";
import { FAILED, FAILURES_BEFORE_PASS, failures, restoreStation } from "../laid.ts";
import type { LaidPhase } from "../laid.ts";
import { parseOrder } from "../order.ts";
import type { Order } from "../order.ts";
import type { CommandResult, CommandRunner } from "../runner.ts";
import { SpaceError } from "../space.ts";
import type { Bead, Space } from "../space.ts";
import { offeredCheckouts } from "../station.ts";
import type { Station } from "../station.ts";
import type { TurnHandle, TurnMode, TurnRunner } from "./claude.ts";
import { ensureWorktree, PER_ORDER, WorktreeError } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

/** How often a living turn's leases are heartbeated: well under bd's five-minute lease. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** The pass laid at the second failure, titled for the phase slug as intake's `no station for` pass is. */
export const TURN_FAILED = "turn failed";

/** What the harness prints (on standard error, and in a print-mode result) when a headless session reaches its dollar cap. */
const BUDGET_OVERRUN = /Budget limit reached|past its --max-budget-usd limit/;

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

/** The turn closed its phase; left it open, so it was reclaimed; or failed, so it was reopened with a count. */
export type TurnOutcome = "closed" | "reclaimed" | "failed";

export interface TurnEnd {
  /** The last line of the session's standard output, or the exit code when it printed nothing. */
  resultLine: string;
  exitCode: number;
  outcome: TurnOutcome;
  /** Why the turn failed, when it did: the exit, the budget overrun or the kill. */
  failure?: string;
  /** The phase's failure count after this turn, when it failed. */
  failures?: number;
  /** The `turn failed` pass laid at the second failure. */
  pass?: string;
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

/** One heartbeat of a turn's leases, or the refusal that ended them. */
export interface HeartbeatEvent {
  phase: string;
  order: string;
  station: string;
  refused?: string;
}

export interface EndTurnDeps {
  /** The space under the expeditor actor: the result line, the restore, the failure count and the pass are its writes. */
  expeditor: Space;
  /** The space under the station actor: the heartbeats and the releases are the holder's. */
  station: Space;
  clock: Clock;
  /** The person the `turn failed` pass is for. */
  owner: string;
  onHeartbeat?(event: HeartbeatEvent): void;
  /** Called when the wall-clock timeout kills the child. */
  onKill?(reason: string): void;
}

/**
 * Keeps the leases alive and the wall clock watched until the session ends, comments its result line
 * on the phase, settles the phase (closed, reclaimed or failed) and releases the order, whatever
 * happened before.
 */
export async function endTurn(deps: EndTurnDeps, turn: Turn): Promise<TurnEnd> {
  try {
    const ended = new AbortController();
    const lease = keepLease(deps, turn, ended.signal);
    const watch = watchClock(deps, turn, ended.signal);
    const result = await turn.handle.done;
    ended.abort();
    await lease;
    const killed = await watch;
    const resultLine = lastLine(result.stdout) ?? `exit ${result.exitCode}`;
    await deps.expeditor.comment(turn.phase.id, resultLine);
    const phase = await deps.expeditor.show(turn.phase.id);
    if (phase.status === "closed") return { resultLine, exitCode: result.exitCode, outcome: "closed" };
    // Left open: the station's claim is released and the phase goes back to the station it was laid for.
    await deps.station.release(phase);
    const failure = failureOf(result, killed);
    if (failure === undefined) {
      await restoreStation(deps.expeditor, phase);
      return { resultLine, exitCode: result.exitCode, outcome: "reclaimed" };
    }
    const before = failures(phase);
    const count = before + 1;
    await restoreStation(deps.expeditor, phase, { addLabels: [`${FAILED}:${count}`], removeLabels: before ? [`${FAILED}:${before}`] : [] });
    const end: TurnEnd = { resultLine, exitCode: result.exitCode, outcome: "failed", failure, failures: count };
    if (count >= FAILURES_BEFORE_PASS) end.pass = await layTurnFailedPass(deps, turn, phase, { count, failure, resultLine });
    return end;
  } finally {
    await deps.station.release({ id: turn.order.id, issue_type: "epic" });
  }
}

/** Heartbeats the phase and its order as the station every interval until the turn ends, or until bd refuses one. */
async function keepLease(deps: EndTurnDeps, turn: Turn, signal: AbortSignal): Promise<void> {
  const event = { phase: turn.phase.id, order: turn.order.id, station: turn.phase.station };
  while (await sleptOut(deps.clock, HEARTBEAT_INTERVAL_MS, signal)) {
    try {
      await deps.station.heartbeat(turn.phase.id);
      await deps.station.heartbeat(turn.order.id);
      deps.onHeartbeat?.(event);
    } catch (error) {
      if (!(error instanceof SpaceError)) throw error;
      // Held no longer (reclaimed, or closed under the turn): the lease is not this turn's to keep.
      deps.onHeartbeat?.({ ...event, refused: error.result.stderr.trim() || error.message });
      return;
    }
  }
}

/** Kills the child at the station's wall-clock timeout; answers why, or nothing when the turn ended first. */
async function watchClock(deps: EndTurnDeps, turn: Turn, signal: AbortSignal): Promise<string | undefined> {
  const timeout = turn.station.launch.timeout;
  if (!(await sleptOut(deps.clock, durationMs(timeout), signal))) return undefined;
  const reason = `killed at the wall-clock timeout of ${timeout}`;
  turn.handle.kill();
  deps.onKill?.(reason);
  return reason;
}

/** Why the turn failed: the kill, the budget overrun the harness reported, or a non-zero exit. */
function failureOf(result: CommandResult, killed: string | undefined): string | undefined {
  if (killed !== undefined) return killed;
  if (BUDGET_OVERRUN.test(result.stderr) || BUDGET_OVERRUN.test(result.stdout)) return "budget overrun reported by the harness";
  if (result.exitCode !== 0) return `exit ${result.exitCode}`;
  return undefined;
}

/** The pass for the owner, a child of the order, blocking the phase until the owner's word. */
async function layTurnFailedPass(deps: EndTurnDeps, turn: Turn, phase: Bead, last: { count: number; failure: string; resultLine: string }): Promise<string> {
  const pass = await deps.expeditor.layGate({
    blocks: phase.id,
    type: "human",
    title: `${TURN_FAILED}: ${turn.phase.slug}`,
    reason: `${phase.id} (${phase.title}) failed ${last.count} times on ${turn.phase.station}; the last turn ${last.failure}: ${last.resultLine}`,
  });
  // bd gate create takes no parent or assignee: a second call makes the pass the order's child, for the owner.
  await deps.expeditor.update(pass, { parent: turn.order.id, assignee: deps.owner });
  return pass.id;
}

/** The holder named by bd's refusal of a claim, when the error is that. */
function claimedBy(error: unknown): string | undefined {
  if (!(error instanceof SpaceError)) return undefined;
  return /already claimed by (\S+)/.exec(error.result.stderr)?.[1];
}

function lastLine(stdout: string): string | undefined {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
}
