// The clock seam: the expeditor and the CLI read time and wait only through it.
import { setTimeout as wait } from "node:timers/promises";

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => wait(ms),
};
