// The tick: one pass of the expeditor over the work graph, as a sequence of named steps in the order
// the spec lays them (Expeditor, ADR 0003). The source poll lives in poll.ts. The typed gates are evaluated by `bd gate check` and the word on a closed Kitchen-laid
// pass is applied (answers.ts) before anything is dispatched. The leases of the turns this host runs are
// heartbeated by the turns themselves (turn.ts), on their own interval between ticks; the `leases`
// step reports them and the `reclaim` step reverts the stale leases bd finds and restores each phase's
// assignee from its `station:` label, since reclaim clears it.
// Every step writes one log line; what a step drops or starts is logged with the reason.
import { expeditorActor, parseActor, stationActor } from "../actor.ts";
import type { Clock } from "../clock.ts";
import { readHostConfig } from "../config.ts";
import type { HostConfig } from "../config.ts";
import { FAILURES_BEFORE_PASS, parseLaidPhase, LaidPhaseError, restoreStation, WAITING } from "../laid.ts";
import type { LaidPhase } from "../laid.ts";
import { LOOP } from "../order.ts";
import { readStations } from "../registered.ts";
import type { CommandRunner } from "../runner.ts";
import { openSpace, SpaceError } from "../space.ts";
import type { Space } from "../space.ts";
import type { Station } from "../station.ts";
import { APPLIED, applyWord, kitchenLaid } from "./answers.ts";
import type { TurnRunner } from "./claude.ts";
import type { Log } from "./log.ts";
import { pollSources } from "./poll.ts";
import { endTurn, HEARTBEAT_INTERVAL_MS, startTurn, TURN_FAILED } from "./turn.ts";
import type { Turn, TurnEnd } from "./turn.ts";
import { removeWorktree, worktreeOrders, worktreePath, WorktreeError } from "./worktree.ts";

/** The steps of a tick, in order. */
export const TICK_STEPS = [
  "config", "stations", "gates", "passes", "sources", "leases", "reclaim", "worktrees",
  "ready", "orders", "caps", "attended", "dispatch",
] as const;
export type TickStep = (typeof TICK_STEPS)[number];

export interface ExpeditorDeps {
  runner: CommandRunner;
  env: Record<string, string | undefined>;
  log: Log;
  clock: Clock;
  turnRunner: TurnRunner;
}

export interface TickReport {
  tick: number;
  /** The turns this tick started. */
  started: Turn[];
  /** The phases on attended stations, left waiting for `kitchen turn`. */
  waiting: LaidPhase[];
  /** The orders the source poll laid this tick, by id. */
  laid: string[];
}

/** How one started turn ended: its end, or the failure of the ending itself (a bd call refused), logged and left to `bd reclaim`. */
export type TurnEnding = TurnEnd | { failed: string };

export interface Expeditor {
  tick(): Promise<TickReport>;
  /** Resolves when every turn started so far has ended. */
  settle(): Promise<TurnEnding[]>;
}

/** A ready phase with the station it is assigned to. */
interface Candidate {
  phase: LaidPhase;
  station: Station;
}

interface TickState {
  config: HostConfig;
  /** The space under the expeditor actor: every read, and every write beads does not require from a holder. */
  space: Space;
  stations: Station[];
  /** The space under each station's actor, by station title: the take, the claim and the release. */
  stationSpaces: Map<string, Space>;
  candidates: Candidate[];
  /** Orders taken by a turn, by order id, with the station holding them. */
  held: Map<string, string>;
  /** Turns in progress at each station, by station title. */
  running: Map<string, number>;
  report: TickReport;
}

export function expeditor(deps: ExpeditorDeps): Expeditor {
  let count = 0;
  const endings: Promise<TurnEnding>[] = [];
  /** The phases of the turns whose children live now. */
  const alivePhases = new Set<string>();

  const log = (tick: number, step: TickStep, fields: Record<string, unknown> = {}): void => {
    deps.log.write({ tick, step, ...fields });
  };

  /** Why a phase cannot start now: its order is held, or its station is at its cap. */
  const blocked = (state: TickState, { phase, station }: Candidate): { step: "orders" | "caps"; reason: string } | undefined => {
    const holder = state.held.get(phase.order);
    if (holder !== undefined) return { step: "orders", reason: `held by ${holder}` };
    if ((state.running.get(station.title) ?? 0) >= station.cap) return { step: "caps", reason: `at its cap of ${station.cap}` };
    return undefined;
  };

  /** Drops the candidates one step refuses, logging each with its reason. */
  const drop = (state: TickState, step: "orders" | "caps"): void => {
    state.candidates = state.candidates.filter((candidate) => {
      const why = blocked(state, candidate);
      if (why?.step !== step) return true;
      log(state.report.tick, step, { phase: candidate.phase.id, [step === "orders" ? "order" : "station"]: step === "orders" ? candidate.phase.order : candidate.station.title, dropped: why.reason });
      return false;
    });
  };

  const steps: Record<Exclude<TickStep, "config">, (state: TickState) => Promise<void>> = {
    stations: async (state) => {
      state.stations = await readStations(state.space, { owner: state.config.owner, host: state.config.host });
      for (const station of state.stations) {
        state.stationSpaces.set(station.title, openSpace({ runner: deps.runner, env: deps.env, config: state.config, actor: stationActor(station.owner, station.name) }));
      }
      log(state.report.tick, "stations", { stations: state.stations.map((s) => s.title) });
    },

    gates: async (state) => {
      // bd evaluates the typed gates itself (gh pr view for gh:pr, gh run view for gh:run, the clock for
      // timer, the target's status for bead) and closes the resolved ones; the phase behind one is in
      // bd ready from the next tick. No session is spent on a wait.
      const check = await state.space.checkGates();
      if (check === undefined) log(state.report.tick, "gates", { gates: "none open" });
      else log(state.report.tick, "gates", { ...check });
    },

    passes: async (state) => {
      // Every closed pass of the owner not yet applied: a pass is laid for the owner, so the assignee
      // keeps the typed gates (unassigned) and other owners' passes out, and bd keeps the labelled ones
      // out. The expeditor passes over a recipe's pass: its turn applies the word.
      const applied: string[] = [];
      for (const gate of await state.space.list({ type: "gate", assignee: state.config.owner, status: "closed", excludeLabels: [APPLIED] })) {
        // Checked again here, so a pass listed with the label anyway is never applied twice.
        if (gate.labels?.includes(APPLIED)) {
          log(state.report.tick, "passes", { pass: gate.id, skipped: "applied already" });
          continue;
        }
        if (!kitchenLaid(gate)) {
          if (gate.await_type === "human") log(state.report.tick, "passes", { pass: gate.id, skipped: "not a pass Kitchen laid: its turn applies the word" });
          continue;
        }
        try {
          const done = await applyWord(state.space, gate, state.config.owner);
          applied.push(gate.id);
          log(state.report.tick, "passes", { ...done });
        } catch (error) {
          // A bd call that failed (a phase still held by a turn, an order with another open pass) leaves
          // the pass unlabelled, so the next tick applies it again once what refused it is put right.
          if (!(error instanceof SpaceError)) throw error;
          log(state.report.tick, "passes", { pass: gate.id, failed: error.message });
        }
      }
      log(state.report.tick, "passes", { applied });
    },

    sources: async (state) => {
      const polled = await pollSources({
        clock: deps.clock,
        space: state.space, runner: deps.runner, owner: state.config.owner, host: state.config.host,
        log: (fields) => log(state.report.tick, "sources", fields),
      });
      state.report.laid.push(...polled.orders);
      log(state.report.tick, "sources", { sources: polled.sources, orders: polled.orders });
    },

    leases: async (state) => {
      // The turns heartbeat their own leases on the interval while their children live (turn.ts); the
      // tick reports the ones alive.
      log(state.report.tick, "leases", { alive: [...alivePhases], interval: `${HEARTBEAT_INTERVAL_MS / 1000}s` });
    },

    reclaim: async (state) => {
      // bd reclaim clears the assignee of every stale lease it reverts; a phase carries the station it
      // was laid for as its `station:` label, so it goes back to that station. An order's take has no
      // label and stays released, which is the release the dead turn never made.
      const reclaimed = await state.space.reclaim();
      const restored: Record<string, string> = {};
      for (const lease of reclaimed) {
        const station = await restoreStation(state.space, await state.space.show(lease.id));
        if (station !== undefined) restored[lease.id] = station;
      }
      log(state.report.tick, "reclaim", { reclaimed: reclaimed.map((lease) => lease.id), restored });
    },
    worktrees: async (state) => {
      // Every checkout of this host's stations, once each, with the orders that have a worktree in it;
      // an order is read once however many checkouts hold it. Cleanup runs on this host's own clock, so
      // an order closed while the host was off is removed on its first tick back.
      const checkouts = [...new Set(state.stations.flatMap((s) => s.launch.repositories.map((r) => r.path)))];
      const holding = new Map<string, string[]>();
      for (const checkout of checkouts) {
        // A checkout whose worktrees directory cannot be read (gone with the checkout, its mode) is logged and left for the next tick.
        let orders: string[];
        try {
          orders = worktreeOrders(checkout);
        } catch (error) {
          log(state.report.tick, "worktrees", { checkout, failed: error instanceof Error ? error.message : String(error) });
          continue;
        }
        for (const order of orders) holding.set(order, [...(holding.get(order) ?? []), checkout]);
      }
      const removed: string[] = [];
      const kept: string[] = [];
      for (const [order, paths] of holding) {
        // One order's cleanup failing (its bead gone, a worktree git refuses to remove, a stray
        // directory) is logged and leaves the rest of the tick to run; the next tick tries it again.
        try {
          const closed = (await state.space.show(order)).status === "closed";
          for (const checkout of paths) {
            if (closed) removed.push(await removeWorktree(deps.runner, checkout, order));
            else kept.push(worktreePath(checkout, order));
          }
        } catch (error) {
          if (!(error instanceof SpaceError || error instanceof WorktreeError)) throw error;
          log(state.report.tick, "worktrees", { order, failed: error.message });
        }
      }
      log(state.report.tick, "worktrees", { removed, kept });
    },

    ready: async (state) => {
      for (const station of state.stations) {
        for (const bead of await state.space.ready({ assignee: station.title })) {
          try {
            const phase = parseLaidPhase(bead);
            // bd ready should not list a phase behind its `turn failed` pass; one listed anyway is not retried.
            if (phase.failures >= FAILURES_BEFORE_PASS) {
              log(state.report.tick, "ready", { phase: phase.id, dropped: `failed:${phase.failures}: waits for the ${TURN_FAILED} pass` });
              continue;
            }
            state.candidates.push({ phase, station });
          } catch (error) {
            if (!(error instanceof LaidPhaseError)) throw error;
            log(state.report.tick, "ready", { phase: bead.id, dropped: error.message });
          }
        }
      }
      log(state.report.tick, "ready", { phases: state.candidates.map((c) => c.phase.id) });
    },

    orders: async (state) => {
      // An order is held when a station's turn has taken it: the claim sets the station as assignee.
      // An order in progress for any other reason, or assigned to a person, is not a take.
      for (const order of await state.space.list({ type: "epic", labels: [LOOP], status: "in_progress" })) {
        if (typeof order.assignee === "string" && parseActor(order.assignee).kind === "station") state.held.set(order.id, order.assignee);
      }
      drop(state, "orders");
      log(state.report.tick, "orders", { held: [...state.held.keys()] });
    },

    caps: async (state) => {
      for (const station of state.stations) {
        // The order a station holds is assigned to it too; only the phases count as turns.
        const turns = (await state.space.list({ assignee: station.title, status: "in_progress" })).filter((b) => b.issue_type !== "epic");
        state.running.set(station.title, turns.length);
      }
      drop(state, "caps");
      log(state.report.tick, "caps", { running: Object.fromEntries(state.running) });
    },

    attended: async (state) => {
      state.candidates = state.candidates.filter(({ phase, station }) => {
        if (!station.attended) return true;
        state.report.waiting.push(phase);
        return false;
      });
      for (const phase of state.report.waiting) {
        if (!phase.labels.includes(WAITING)) await state.space.update({ id: phase.id, issue_type: "task" }, { addLabels: [WAITING] });
        log(state.report.tick, "attended", { phase: phase.id, station: phase.station, waiting: `kitchen turn ${phase.id}` });
      }
      log(state.report.tick, "attended", { waiting: state.report.waiting.map((p) => p.id) });
    },

    dispatch: async (state) => {
      for (const candidate of state.candidates) {
        const { phase, station } = candidate;
        // What this tick started counts at once: one turn per order, one slot per turn.
        const why = blocked(state, candidate);
        if (why) {
          log(state.report.tick, "dispatch", { phase: phase.id, order: phase.order, station: station.title, dropped: why.reason });
          continue;
        }
        const stationSpace = state.stationSpaces.get(station.title);
        if (!stationSpace) continue;
        const start = await startTurn({ station: stationSpace, runner: deps.turnRunner, git: deps.runner }, station, phase, "headless");
        if (start.kind !== "started") {
          const dropped = start.kind === "held" ? `order held by ${start.by}` : start.kind === "claimed" ? `phase claimed by ${start.by}` : start.reason;
          log(state.report.tick, "dispatch", { phase: phase.id, order: phase.order, dropped });
          continue;
        }
        state.held.set(phase.order, station.title);
        state.running.set(station.title, (state.running.get(station.title) ?? 0) + 1);
        state.report.started.push(start.turn);
        log(state.report.tick, "dispatch", { phase: phase.id, order: phase.order, station: station.title, model: phase.model, worktrees: start.turn.worktrees.map((w) => w.path), argv: start.turn.handle.argv, cwd: start.turn.handle.cwd ?? null });
        alivePhases.add(phase.id);
        const tick = state.report.tick;
        const ending = endTurn(
          {
            expeditor: state.space,
            station: stationSpace,
            clock: deps.clock,
            owner: state.config.owner,
            onHeartbeat: (event) => deps.log.write({ tick, step: "heartbeat", ...event }),
            onKill: (killed) => deps.log.write({ tick, step: "turn", phase: phase.id, order: phase.order, station: station.title, killed }),
          },
          start.turn,
        );
        endings.push(
          ending
            .finally(() => alivePhases.delete(phase.id))
            .then((end): TurnEnding => {
              deps.log.write({
                tick, step: "turn", phase: phase.id, order: phase.order, station: station.title,
                exit: end.exitCode, result: end.resultLine, outcome: end.outcome,
                ...(end.failure === undefined ? {} : { failure: end.failure, failures: end.failures }),
                ...(end.pass === undefined ? {} : { pass: end.pass }),
              });
              return end;
            })
            .catch((error: unknown): TurnEnding => {
              // Nothing awaits an ending but settle(), so a rejection left here would be unhandled and
              // end the process with every other running turn's child. Whatever the ending threw (a bd
              // call refused: bd unreachable, the lease taken elsewhere; an answer that parses as no
              // bead; the log itself) is logged, where the log still takes it, and the service goes on:
              // the phase and its take are bd reclaim's once their leases go stale.
              const failed = error instanceof Error ? error.message : String(error);
              try {
                deps.log.write({ tick, step: "turn", phase: phase.id, order: phase.order, station: station.title, failed });
              } catch (unlogged) {
                process.stderr.write(`turn ${phase.id} ended with ${failed}; the log refused the line: ${unlogged instanceof Error ? unlogged.message : String(unlogged)}\n`);
              }
              return { failed };
            }),
        );
      }
      log(state.report.tick, "dispatch", { started: state.report.started.map((t) => t.phase.id) });
    },
  };

  return {
    tick: async () => {
      const tick = ++count;
      const report: TickReport = { tick, started: [], waiting: [], laid: [] };
      const config = readHostConfig(deps.env);
      if (!config) {
        log(tick, "config", { stopped: "no host config: run kitchen init first" });
        return report;
      }
      log(tick, "config", { owner: config.owner, host: config.host, server: `${config.server.host}:${config.server.port}` });
      const state: TickState = {
        config,
        space: openSpace({ runner: deps.runner, env: deps.env, config, actor: expeditorActor(config.owner) }),
        stations: [],
        stationSpaces: new Map(),
        candidates: [],
        held: new Map(),
        running: new Map(),
        report,
      };
      for (const step of TICK_STEPS) {
        if (step !== "config") await steps[step](state);
      }
      return report;
    },
    settle: () => Promise.all(endings),
  };
}
