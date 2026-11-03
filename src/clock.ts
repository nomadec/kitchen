// The clock seam: the expeditor and the CLI read time and wait only through it.
import { setTimeout as wait } from "node:timers/promises";

export interface SleepOptions {
  /** Ends the sleep early: the promise rejects with an AbortError, as node's timers do. */
  signal?: AbortSignal;
}

export interface Clock {
  now(): Date;
  sleep(ms: number, options?: SleepOptions): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, options = {}) => wait(ms, undefined, options.signal ? { signal: options.signal } : {}),
};

/** Whether an error is the rejection of a sleep that was aborted. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Sleeps the whole time and answers true, or answers false when the signal ends the sleep first. */
export async function sleptOut(clock: Clock, ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await clock.sleep(ms, { signal });
    return true;
  } catch (error) {
    if (isAbort(error)) return false;
    throw error;
  }
}

/** A duration such as `45m`, `90s` or `2h`, in milliseconds. */
export function durationMs(duration: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(duration);
  if (!match) throw new Error(`not a duration: ${duration}`);
  const [, amount, unit] = match;
  return Number(amount) * { s: 1_000, m: 60_000, h: 3_600_000 }[unit as "s" | "m" | "h"];
}
