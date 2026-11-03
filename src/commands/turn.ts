// kitchen turn: one waiting phase on an attended station of this owner on this host, run in the
// foreground on the human's word (spec: Expeditor; story 53). The same take, claim, worktree and spawn
// steps as the expeditor's dispatch, through the shared startTurn and endTurn, with the runner in
// interactive mode: claude without the print flag and the dollar cap, attached to this terminal. The
// take is the per-order limit held in the space, so an expeditor on any host skips the order while the
// turn runs. The turn is bounded by the station's wall-clock timeout and the phase's `rounds`, which
// the turn driver counts; on exit the shared handling comments the result line and releases the order.
import { parseArgs } from "node:util";
import { actorName, expeditorActor, stationActor } from "../actor.ts";
import type { Command } from "../cli.ts";
import type { HostConfig } from "../config.ts";
import { claudeRunner } from "../expeditor/claude.ts";
import { endTurn, startTurn } from "../expeditor/turn.ts";
import { parseLaidPhase, LaidPhaseError } from "../laid.ts";
import type { LaidPhase } from "../laid.ts";
import { readStations } from "../registered.ts";
import type { CommandRunner } from "../runner.ts";
import { openSpace, SpaceError } from "../space.ts";
import type { Space } from "../space.ts";
import { StationError } from "../station.ts";
import type { Station } from "../station.ts";
import { openHostSpace } from "./host-space.ts";

const USAGE = `Usage: kitchen turn <phase>

Runs one waiting phase on an attended station of yours on this host, in this terminal: the order is
taken and the phase claimed as the station, the order's worktrees are prepared, and claude starts
interactive (no print flag, no dollar cap) with the Kitchen plugin and the station's plugins. The
turn is bounded by the station's wall-clock timeout and the phase's rounds. When the session ends
its result is commented on the phase and the order is released.
`;

export const turn: Command = async (args, deps) => {
  const fail = (message: string, usage = false): number => {
    deps.stderr(`kitchen turn: ${message}\n${usage ? `\n${USAGE}` : ""}`);
    return 1;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), true);
  }
  const [id, ...more] = positionals;
  if (id === undefined) return fail("a phase id is required", true);
  if (more.length) return fail(`one phase at a time, got ${positionals.join(" ")}`, true);

  const opened = openHostSpace(deps);
  if ("error" in opened) return fail(opened.error, true);
  const { space, config } = opened;
  if (space.actor.kind !== "human") {
    return fail(`a turn on an attended station starts on a person's word, not from a session running as ${actorName(space.actor)}`);
  }

  let waiting: { phase: LaidPhase; station: Station };
  try {
    waiting = await readWaiting(space, config, id);
  } catch (error) {
    if (error instanceof Refusal || error instanceof SpaceError || error instanceof LaidPhaseError || error instanceof StationError) return fail(error.message);
    throw error;
  }
  const { phase, station } = waiting;

  // Said before the spawn: once the session is attached to the terminal, the terminal is its.
  deps.stdout(`Turn on ${phase.id} (${phase.title}) at ${station.title}, order ${phase.order}: taking the order and claiming the phase as the station\n`);
  const stationSpace = openSpace({ runner: deps.runner, env: deps.env, config, actor: stationActor(station.owner, station.name) });
  const start = await startTurn(
    { station: stationSpace, runner: claudeRunner({ runner: attached(deps.runner), env: deps.env, config, pluginDir: deps.program.pluginDir }), git: deps.runner },
    station,
    phase,
    "interactive",
  );
  if (start.kind === "held") return fail(`order ${phase.order} is held by ${start.by}: its turn must end first`);
  if (start.kind === "claimed") return fail(`${phase.id} is held by another turn at ${start.by}`);
  if (start.kind === "unprepared") return fail(`${phase.id} could not start: ${start.reason}`);

  // The writes at the end that are not the holder's (the result line, and what the shared handling adds) are the expeditor's, as in a tick.
  const expeditor = openSpace({ runner: deps.runner, env: deps.env, config, actor: expeditorActor(config.owner) });
  const end = await endTurn({ expeditor, station: stationSpace }, start.turn);
  if (end.exitCode !== 0) {
    deps.stderr(`kitchen turn: the session exited ${end.exitCode}: ${phase.id} is a failed turn (${end.resultLine})\n`);
    return end.exitCode;
  }
  deps.stdout(`Turn ended: ${end.resultLine}\n`);
  return 0;
};

/** A phase that cannot be turned here; the message says why. No write was issued. */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/** The phase and its station, when the phase waits on an attended station of this owner on this host. */
async function readWaiting(space: Space, config: Pick<HostConfig, "owner" | "host">, id: string): Promise<{ phase: LaidPhase; station: Station }> {
  const bead = await space.show(id);
  const phase = parseLaidPhase(bead);
  const station = (await readStations(space, { owner: config.owner })).find((s) => s.title === phase.station);
  if (!station) throw new Refusal(`${phase.id} is assigned to ${phase.station}, not a station of ${config.owner}`);
  if (station.host !== config.host) throw new Refusal(`${phase.id} is assigned to ${station.title} on host ${station.host}, not this host (${config.host})`);
  if (!station.attended) throw new Refusal(`${phase.id} is assigned to ${station.title}, an unattended station: the expeditor starts its turns`);
  if (bead.status === "closed") throw new Refusal(`${phase.id} is closed`);
  if (bead.status === "in_progress") throw new Refusal(`${phase.id} is held by a turn at ${phase.station}`);
  const ready = await space.ready({ assignee: station.title });
  if (!ready.some((b) => b.id === phase.id)) throw new Refusal(`${phase.id} is not ready: blocked by an open pass or dependency`);
  return { phase, station };
}

/** The runner the session's spawn goes through: the one call the claude runner makes, attached to this terminal. */
function attached(runner: CommandRunner): CommandRunner {
  return (argv, options = {}) => runner(argv, { ...options, stdio: "inherit" });
}
