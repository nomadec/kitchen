// kitchen status: the expeditor's state on this host (story 59), read from the state file the resident
// process keeps and from the space: whether it runs and when it last ticked, the turns running at this
// host's stations with their orders, the phases waiting on attended stations with the `kitchen turn`
// command that starts each, the open passes, and each station's cap against its running count.
// Reads only; nothing is written to the space.
import type { Command } from "../cli.ts";
import { expeditorStateFile } from "../config.ts";
import { isStale, readState } from "../expeditor/state.ts";
import type { ExpeditorState } from "../expeditor/state.ts";
import type { Order } from "../order.ts";
import { nameOrder, readOrders, readPasses } from "../pass.ts";
import type { Pass } from "../pass.ts";
import { readStations } from "../registered.ts";
import { SpaceError } from "../space.ts";
import type { Bead } from "../space.ts";
import { StationError } from "../station.ts";
import type { Station } from "../station.ts";
import { openHostSpace } from "./host-space.ts";

const USAGE = `Usage: kitchen status

Shows this host's expeditor (running or not, and its last tick), the turns running at this host's
stations with their orders, the phases waiting on attended stations with the kitchen turn command
that starts each, the open passes, and each station's cap against the turns it runs. Reads only.
`;

interface Picture {
  host: string;
  stateFile: string;
  state: ExpeditorState | undefined;
  now: Date;
  stations: Station[];
  orders: Map<string, Order>;
  /** The phases in progress at each station, by station title. */
  running: Map<string, Bead[]>;
  /** The ready phases of each attended station, by station title. */
  waiting: Map<string, Bead[]>;
  passes: Pass[];
}

export const status: Command = async (args, deps) => {
  const fail = (message: string, usage = false): number => {
    deps.stderr(`kitchen status: ${message}\n${usage ? `\n${USAGE}` : ""}`);
    return 1;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  if (args.length) return fail("takes no arguments", true);
  const opened = openHostSpace(deps);
  if ("error" in opened) return fail(opened.error, true);
  const { space, config } = opened;

  const stateFile = expeditorStateFile(deps.env);
  const picture: Picture = {
    host: config.host, stateFile, state: readState(stateFile), now: deps.clock.now(),
    stations: [], orders: new Map(), running: new Map(), waiting: new Map(), passes: [],
  };
  try {
    picture.stations = await readStations(space, { owner: config.owner, host: config.host });
    picture.orders = await readOrders(space);
    for (const station of picture.stations) {
      // The order a station holds is assigned to it too; only the phases are turns.
      const turns = (await space.list({ assignee: station.title, status: "in_progress" })).filter((b) => b.issue_type !== "epic");
      picture.running.set(station.title, turns);
    }
    for (const station of picture.stations.filter((s) => s.attended)) {
      picture.waiting.set(station.title, await space.ready({ assignee: station.title }));
    }
    picture.passes = await readPasses(space);
  } catch (error) {
    if (error instanceof SpaceError || error instanceof StationError) return fail(error.message);
    throw error;
  }
  deps.stdout(render(picture));
  return 0;
};

function render(p: Picture): string {
  const phaseLine = (bead: Bead, station: string) => `  ${bead.id}  ${bead.title}  order ${nameOrder(typeof bead.parent === "string" ? bead.parent : undefined, p.orders)}  at ${station}`;
  const turns = [...p.running].flatMap(([station, beads]) => beads.map((bead) => phaseLine(bead, station)));
  const waiting = [...p.waiting].flatMap(([station, beads]) => beads.flatMap((bead) => [phaseLine(bead, station), `    kitchen turn ${bead.id}`]));
  const passes = p.passes.flatMap((pass) => [
    `  ${pass.id}  ${pass.title}  order ${nameOrder(pass.order, p.orders)}`,
    ...(pass.brief ?? "(no brief yet)").split("\n").map((line) => `    ${line}`),
  ]);
  const width = Math.max(0, ...p.stations.map((s) => s.title.length));
  const stations = p.stations.map(
    (s) => `  ${s.title.padEnd(width)}  ${(s.attended ? "attended" : "unattended").padEnd(10)}  ${p.running.get(s.title)?.length ?? 0} of ${s.cap} running`,
  );
  const section = (title: string, lines: string[], none = "  none") => [title, ...(lines.length ? lines : [none]), ""];
  return [
    expeditorLine(p),
    "",
    ...section("Running turns:", turns),
    ...section("Waiting for kitchen turn:", waiting),
    ...section("Open passes:", passes),
    ...section(`Stations on ${p.host}:`, stations, "  none registered: run kitchen station add"),
  ].join("\n");
}

/** Running, or not running with the reason: no file, a clean stop, or a file the next tick never refreshed. */
function expeditorLine(p: Picture): string {
  const head = `Expeditor on ${p.host}:`;
  const s = p.state;
  if (!s) return `${head} not running (no state file at ${p.stateFile}: run kitchen up)`;
  if (s.stopped !== undefined) return `${head} not running (stopped at ${s.stopped} after tick ${s.tick})`;
  if (isStale(s, p.now)) return `${head} not running (pid ${s.pid} last ticked at ${s.at}, tick ${s.tick}, and ticks every ${s.interval}s: it died or hangs)`;
  return `${head} running (pid ${s.pid}), tick ${s.tick} at ${s.at}, every ${s.interval}s, since ${s.started}`;
}
