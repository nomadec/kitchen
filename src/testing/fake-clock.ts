// A clock that stands still until a test advances it. Sleeping advances it by the slept time.
import type { Clock } from "../clock.ts";

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function fakeClock(start: Date = new Date("2026-01-01T00:00:00Z")): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    sleep: async (ms) => {
      current += ms;
    },
  };
}
