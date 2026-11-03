// Starting and ending one turn: the take on the order and the claim on the phase, both under the
// station actor because beads requires them from the holder, the order's worktrees between them, then
// the runner. While the child lives the station heartbeats both leases on an interval and the station's
// wall-clock timeout kills a child that outlives it. At the end the result line (the session's last
// line, else the `result:` note the driver wrote during the turn when its output is the terminal's) is commented on
// the phase as the expeditor; a phase the child left open is set open again by the station, the
// holder, in one write that keeps it assigned to the station its `station:` label names and counts a
// failed turn as `failed:<n>`, and the second failure lays the `turn failed` pass for the owner as
// the expeditor. A phase or an order this station holds no longer (reclaimed and taken elsewhere) is
// left alone. The order is released by the station on every other path. The expeditor's dispatch and
// a foreground `kitchen turn` share these two functions.
import { durationMs, sleptOut } from "../clock.ts";
import type { Clock } from "../clock.ts";
import { noteLine } from "../fields.ts";
import { FAILED, FAILURES_BEFORE_PASS, failures, restoreStation } from "../laid.ts";
import type { LaidPhase } from "../laid.ts";
import { parseOrder } from "../order.ts";
import type { Order } from "../order.ts";
import type { CommandResult, CommandRunner } from "../runner.ts";
import { SpaceError } from "../space.ts";
import type { Bead, Space } from "../space.ts";
import { offeredCheckouts } from "../station.ts";
import type { Station } from "../station.ts";
import { LaunchError } from "./claude.ts";
import type { TurnHandle, TurnMode, TurnRunner } from "./claude.ts";
import { ensureWorktree, PER_ORDER, WorktreeError } from "./worktree.ts";
import type { Worktree } from "./worktree.ts";

/** How often a living turn's leases are heartbeated: well under bd's five-minute lease. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** The pass laid at the second failure, titled for the phase slug as intake's `no station for` pass is. */
export const TURN_FAILED = "turn failed";

/** What the harness prints (on standard error, and in a print-mode result) when a headless session reaches its dollar cap. */
const BUDGET_OVERRUN = /Budget limit reached|past its --max-budget-usd limit/;

/** The note the turn driver writes its result line into, read when the session's output was the terminal's. */
export const RESULT_NOTE = "result";

export interface Turn {
  phase: LaidPhase;
  station: Station;
  order: Order;
  mode: TurnMode;
  /** The order's worktrees in this station's checkouts, in the order the order names its repositories. */
  worktrees: Worktree[];
  handle: TurnHandle;
  /** The `result:` note as the claim found it, so a line an earlier turn left is not taken for this one's. */
  resultBefore?: string;
}

export type TurnStart =
  | { kind: "started"; turn: Turn }
  /** The order is held by another turn: its take refused the station, naming the holder. */
  | { kind: "held"; by: string }
  /** The phase was claimed first by another expeditor; the take is released again. */
  | { kind: "claimed"; by: string }
  /** A worktree could not be prepared (git saying why) or the launch could not (a secret unresolved); the take is released, and a phase claimed is open again for its station. */
  | { kind: "unprepared"; reason: string };

/**
 * The turn closed its phase; left it open, so it was reclaimed (open again for its station, or left
 * to the holder that took it meanwhile); or failed, so it was reopened with a count.
 */
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
  let claimed: Bead;
  try {
    claimed = await deps.station.claim({ id: phase.id, issue_type: "task" });
  } catch (error) {
    const holder = claimedBy(error);
    if (!holder) throw error;
    await deps.station.release(order);
    return { kind: "claimed", by: holder };
  }
  let handle: TurnHandle;
  try {
    handle = deps.runner({ launch: station.launch, phase, mode, order: parsed, worktrees });
  } catch (error) {
    if (!(error instanceof LaunchError)) throw error;
    // Open again for its station, not released unassigned: a phase with no assignee is in no ready
    // list and holds no lease, so nothing would surface it once the host holds the secret.
    await deps.station.update({ id: phase.id, issue_type: "task" }, { status: "open", assignee: phase.station });
    await deps.station.release(order);
    return { kind: "unprepared", reason: error.message };
  }
  const turn: Turn = { phase, station, order: parsed, mode, worktrees, handle };
  const resultBefore = noteLine(claimed.notes ?? "", RESULT_NOTE);
  if (resultBefore !== undefined) turn.resultBefore = resultBefore;
  return { kind: "started", turn };
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
 * happened before, except when the turn closed the order itself (that close is the take's end) or
 * when another holder took it meanwhile (the take is theirs).
 */
export async function endTurn(deps: EndTurnDeps, turn: Turn): Promise<TurnEnd> {
  const order = { id: turn.order.id, issue_type: "epic" };
  try {
    const ended = new AbortController();
    const lease = keepLease(deps, turn, ended.signal);
    const watch = watchClock(deps, turn, ended.signal);
    const result = await turn.handle.done;
    ended.abort();
    await lease;
    const killed = await watch;
    const phase = await deps.expeditor.show(turn.phase.id);
    const resultLine = lastLine(result.stdout) ?? resultNote(turn, phase) ?? `exit ${result.exitCode}`;
    await deps.expeditor.comment(turn.phase.id, resultLine);
    if (phase.status === "closed") return { resultLine, exitCode: result.exitCode, outcome: "closed" };
    // Left open, but held by another now: its lease went stale, was reclaimed, and another turn took it.
    if (phase.assignee !== turn.phase.station) return { resultLine, exitCode: result.exitCode, outcome: "reclaimed" };
    const failure = failureOf(result, killed);
    if (failure === undefined) {
      // Open again for the station it was laid for, in the one write beads allows the holder.
      await restoreStation(deps.station, phase, { status: "open" });
      return { resultLine, exitCode: result.exitCode, outcome: "reclaimed" };
    }
    const before = failures(phase);
    const count = before + 1;
    await restoreStation(deps.station, phase, { status: "open", addLabels: [`${FAILED}:${count}`], removeLabels: before ? [`${FAILED}:${before}`] : [] });
    const end: TurnEnd = { resultLine, exitCode: result.exitCode, outcome: "failed", failure, failures: count };
    if (count >= FAILURES_BEFORE_PASS) end.pass = await layTurnFailedPass(deps, turn, phase, { count, failure, resultLine });
    return end;
  } finally {
    // The turn that closes the order (`Order done: ...`) ended the take with that close, and a release
    // would open it again; an order another station holds now is that station's to release.
    const held = await deps.expeditor.show(order.id);
    if (held.status === "in_progress" && held.assignee === turn.phase.station) await deps.station.release(order);
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

/** The signals that stop a service and its children (`kitchen down`, a shutdown, a closed terminal), as the runtime names them. */
const STOP_SIGNALS: readonly string[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * Why the turn failed: the kill, the budget overrun the harness reported, a non-zero exit, or a signal
 * that was no stop (the kernel's SIGKILL at an out-of-memory, a SIGSEGV), which counts like a crash so
 * a child that dies the same way on every start reaches the `turn failed` pass. A child a stop signal
 * ended that was not the wall clock's (`kitchen down` stopping the service, with the child) is no
 * failure of the turn: the phase is reclaimed, and a restart loses nothing.
 */
function failureOf(result: CommandResult, killed: string | undefined): string | undefined {
  if (killed !== undefined) return killed;
  if (result.signal !== undefined) return STOP_SIGNALS.includes(result.signal) ? undefined : `ended by ${result.signal}`;
  if (BUDGET_OVERRUN.test(result.stderr) || BUDGET_OVERRUN.test(result.stdout)) return "budget overrun reported by the harness";
  if (result.exitCode !== 0) return `exit ${result.exitCode}`;
  return undefined;
}

/** The pass for the owner, a child of the order, blocking the phase until the owner's word. */
async function layTurnFailedPass(deps: EndTurnDeps, turn: Turn, phase: Bead, last: { count: number; failure: string; resultLine: string }): Promise<string> {
  const pass = await deps.expeditor.layPass({
    order: turn.order.id,
    blocks: phase.id,
    title: `${TURN_FAILED}: ${turn.phase.slug}`,
    brief: `${phase.id} (${phase.title}) failed ${last.count} times on ${turn.phase.station}; the last turn ${last.failure}: ${last.resultLine}`,
    owner: deps.owner,
  });
  return pass.id;
}

/** The holder named by bd's refusal of a claim, when the error is that. */
function claimedBy(error: unknown): string | undefined {
  if (!(error instanceof SpaceError)) return undefined;
  return /already claimed by (\S+)/.exec(error.result.stderr)?.[1];
}

/** The `result:` note the driver wrote during this turn; one that was there at the claim is an earlier turn's. */
function resultNote(turn: Turn, phase: Bead): string | undefined {
  const line = noteLine(phase.notes ?? "", RESULT_NOTE);
  return line && line !== turn.resultBefore ? line : undefined;
}

function lastLine(stdout: string): string | undefined {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
}
