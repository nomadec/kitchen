// The expeditor's structured log: one JSON object per line, appended under the state directory, so a
// turn can be debugged from the host's side as well as from the bead's comments.
import fs from "node:fs";
import path from "node:path";
import type { Clock } from "../clock.ts";

export interface Log {
  readonly file: string;
  /** Appends one line: the instant, then the fields given. */
  write(fields: Record<string, unknown>): void;
}

export function openLog(file: string, clock: Clock): Log {
  let ready = false;
  return {
    file,
    write(fields) {
      if (!ready) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        ready = true;
      }
      fs.appendFileSync(file, `${JSON.stringify({ at: clock.now().toISOString(), ...fields })}\n`);
    },
  };
}
