// A clock that stands still until a test advances it, or until something sleeps on it. A sleep is a
// wake laid at its due instant; once the work in hand has settled (the microtasks are drained) the
// clock jumps to the earliest wake and resolves it, so sleepers run in due order and a sleep by itself
// still advances the clock by the slept time. An aborted sleep is forgotten and rejects as node's does.
import type { Clock, SleepOptions } from "../clock.ts";

export interface FakeClock extends Clock {
  /** Moves the clock forward, waking every sleeper that falls due. */
  advance(ms: number): void;
}

interface Wake {
  due: number;
  resolve: () => void;
}

export function fakeClock(start: Date = new Date("2026-01-01T00:00:00Z")): FakeClock {
  let current = start.getTime();
  const wakes: Wake[] = [];
  let scheduled = false;

  const wakeDue = (until: number): void => {
    // Earliest due first; among equals, the one laid first.
    wakes.sort((a, b) => a.due - b.due);
    while (wakes[0] && wakes[0].due <= until) {
      const wake = wakes.shift() as Wake;
      current = Math.max(current, wake.due);
      wake.resolve();
    }
  };

  /**
   * After the current work settles, jump to the next wake; one sleeper at a time, so what it does
   * (a kill that ends another sleeper, say) settles before a sleeper due at the same instant runs.
   */
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      wakes.sort((a, b) => a.due - b.due);
      const next = wakes.shift();
      if (!next) return;
      current = Math.max(current, next.due);
      next.resolve();
      if (wakes.length) schedule();
    });
  };

  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
      wakeDue(current);
    },
    sleep: (ms, options: SleepOptions = {}) =>
      new Promise<void>((resolve, reject) => {
        const wake: Wake = { due: current + ms, resolve };
        const abort = (): void => {
          const at = wakes.indexOf(wake);
          if (at !== -1) wakes.splice(at, 1);
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        wake.resolve = () => {
          options.signal?.removeEventListener("abort", abort);
          resolve();
        };
        wakes.push(wake);
        schedule();
      }),
  };
}
