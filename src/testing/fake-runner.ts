// A command runner scripted from a table. It answers bd, git, gh, claude, curl, sh (a verify command)
// and the two service managers (systemctl, launchctl) and records every call. A row that `lasts`
// answers only after that long on the clock, as a child that lives for a while does; killed before
// then, it answers as a child a signal ended. A row that answers `once` is spent after its call.
import type { Clock } from "../clock.ts";
import { sleptOut } from "../clock.ts";
import { KILLED_EXIT_CODE } from "../runner.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "../runner.ts";

export type ScriptedCommand = "bd" | "git" | "gh" | "claude" | "curl" | "sh" | "systemctl" | "launchctl";

export interface ScriptedAnswer {
  command: ScriptedCommand;
  /** The row answers a call whose argv, after the command, starts with these args. */
  args: readonly string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** The signal that ended the child, as a stop of the service ends every turn's child. */
  signal?: string;
  /** How long the child lives on the clock before it answers, in milliseconds; answers at once when absent. */
  lasts?: number;
  /** The row answers one call and is then spent, so the next matching row answers the same call after: a value that moves between reads. */
  once?: boolean;
}

export interface RecordedCall extends CommandOptions {
  argv: string[];
}

export interface FakeRunner extends CommandRunner {
  readonly calls: RecordedCall[];
}

/** Builds a runner from a table of scripted answers. A call no row scripts rejects with the argv. */
export function fakeRunner(table: readonly ScriptedAnswer[], clock?: Clock): FakeRunner {
  const calls: RecordedCall[] = [];
  const spent = new Set<ScriptedAnswer>();
  const runner = async (argv: readonly string[], options: CommandOptions = {}): Promise<CommandResult> => {
    calls.push({ argv: [...argv], ...options });
    const [command, ...args] = argv;
    const row = table.find((r) => !spent.has(r) && r.command === command && r.args.every((arg, i) => args[i] === arg));
    if (!row) throw new Error(`Unexpected command: ${argv.join(" ")}`);
    if (row.once) spent.add(row);
    if (row.lasts !== undefined) {
      if (!clock) throw new Error(`a row that lasts needs the fake runner built with a clock: ${argv.join(" ")}`);
      const lived = await sleptOut(clock, row.lasts, options.signal ?? new AbortController().signal);
      if (!lived) return { stdout: "", stderr: "", exitCode: KILLED_EXIT_CODE, signal: "SIGTERM" };
    }
    return { stdout: row.stdout ?? "", stderr: row.stderr ?? "", exitCode: row.exitCode ?? 0, ...(row.signal === undefined ? {} : { signal: row.signal }) };
  };
  return Object.assign(runner, { calls });
}
