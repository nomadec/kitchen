// The tick: one pass of the expeditor over the work graph, as a sequence of named steps in the order
// the spec lays them (Expeditor, ADR 0003). The steps for typed gates, Kitchen-laid passes, source
// polling, lease heartbeats, reclaim and worktree cleanup are named here and filled by later slices.
// Every step writes one log line; what a step drops or starts is logged with the reason.
import { expeditorActor, parseActor, stationActor } from "../actor.ts";
import { readHostConfig } from "../config.ts";
import type { HostConfig } from "../config.ts";
import { parseLaidPhase, LaidPhaseError, WAITING } from "../laid.ts";
import type { LaidPhase } from "../laid.ts";
import { LOOP } from "../order.ts";
import { readStations } from "../registered.ts";
import type { CommandRunner } from "../runner.ts";
import { openSpace } from "../space.ts";
import type { Space } from "../space.ts";
import type { Station } from "../station.ts";
import type { TurnRunner } from "./claude.ts";
import type { Log } from "./log.ts";
import { endTurn, startTurn } from "./turn.ts";
import type { Turn, TurnEnd } from "./turn.ts";

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
  turnRunner: TurnRunner;
}

export interface TickReport {
  tick: number;
  /** The turns this tick started. */
  started: Turn[];
  /** The phases on attended stations, left waiting for `kitchen turn`. */
  waiting: LaidPhase[];
}

export interface Expeditor {
  tick(): Promise<TickReport>;
  /** Resolves when every turn started so far has ended. */
  settle(): Promise<TurnEnd[]>;
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
  const endings: Promise<TurnEnd>[] = [];

  const log = (tick: number, step: TickStep, fields: Record<string, unknown> = {}): void => {
    deps.log.write({ tick, step, ...fields });
  };

  /** A step a later slice fills: named and logged in its place in the order. */
  const later = (step: TickStep, what: string) => async (state: TickState): Promise<void> => {
    log(state.report.tick, step, { skipped: `${what}: a later slice` });
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

    gates: later("gates", "bd gate check for the typed gates"),
    passes: later("passes", "the word on closed Kitchen-laid passes"),
    sources: later("sources", "polling this host's sources"),
    leases: later("leases", "heartbeating the leases of the turns this host runs"),
    reclaim: later("reclaim", "reclaiming stale leases and restoring the station: label"),
    worktrees: later("worktrees", "removing the worktrees of closed orders"),

    ready: async (state) => {
      for (const station of state.stations) {
        for (const bead of await state.space.ready({ assignee: station.title })) {
          try {
            state.candidates.push({ phase: parseLaidPhase(bead), station });
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
        const start = await startTurn({ station: stationSpace, runner: deps.turnRunner }, station, phase, "headless");
        if (start.kind !== "started") {
          log(state.report.tick, "dispatch", { phase: phase.id, order: phase.order, dropped: `${start.kind === "held" ? "order held" : "phase claimed"} by ${start.by}` });
          continue;
        }
        state.held.set(phase.order, station.title);
        state.running.set(station.title, (state.running.get(station.title) ?? 0) + 1);
        state.report.started.push(start.turn);
        log(state.report.tick, "dispatch", { phase: phase.id, order: phase.order, station: station.title, model: phase.model, argv: start.turn.handle.argv, cwd: start.turn.handle.cwd ?? null });
        endings.push(
          endTurn({ expeditor: state.space, station: stationSpace }, start.turn).then((end) => {
            deps.log.write({ tick: state.report.tick, step: "turn", phase: phase.id, order: phase.order, station: station.title, exit: end.exitCode, result: end.resultLine });
            return end;
          }),
        );
      }
      log(state.report.tick, "dispatch", { started: state.report.started.map((t) => t.phase.id) });
    },
  };

  return {
    tick: async () => {
      const tick = ++count;
      const report: TickReport = { tick, started: [], waiting: [] };
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
