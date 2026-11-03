// The expeditor's state file: one JSON object under the state directory that the resident process
// rewrites at every tick, so `kitchen status` can say whether an expeditor runs on this host and when
// it last ticked without reaching the process. A clean stop records its instant; a process that died
// leaves the file as it was, which status reads as stale once the next tick is overdue.
import fs from "node:fs";
import path from "node:path";
import type { Clock } from "../clock.ts";

export interface ExpeditorState {
  pid: number;
  owner: string;
  host: string;
  /** Seconds between ticks. */
  interval: number;
  /** When the process started, as an instant. */
  started: string;
  /** How many ticks it has run; 0 before the first. */
  tick: number;
  /** When the last tick ended, or the start before the first. */
  at: string;
  /** When the process stopped cleanly; absent while it runs or when it died. */
  stopped?: string;
}

/** Ticks a running expeditor may miss before status treats it as gone. */
export const STALE_AFTER_TICKS = 3;

/** Whether a state file, read at `now`, is one of a process that stopped or that missed too many ticks. */
export function isStale(state: ExpeditorState, now: Date): boolean {
  return state.stopped !== undefined || now.getTime() - Date.parse(state.at) > STALE_AFTER_TICKS * state.interval * 1000;
}

export function readState(file: string): ExpeditorState | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as ExpeditorState;
}

/** Writes the file whole, through a temporary name, so a reader never sees half a tick. */
export function writeState(file: string, state: ExpeditorState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/** The state file of one expeditor run: written at the start, after each tick, and at the stop. */
export function expeditorState(file: string, clock: Clock, fields: Pick<ExpeditorState, "pid" | "owner" | "host" | "interval">) {
  const started = clock.now().toISOString();
  const state: ExpeditorState = { ...fields, started, tick: 0, at: started };
  writeState(file, state);
  return {
    ticked(tick: number): void {
      state.tick = tick;
      state.at = clock.now().toISOString();
      writeState(file, state);
    },
    stopped(): void {
      state.stopped = clock.now().toISOString();
      writeState(file, state);
    },
  };
}
