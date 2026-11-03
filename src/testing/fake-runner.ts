// A command runner scripted from a table. It answers bd, git, gh and claude and records every call.
import type { CommandOptions, CommandResult, CommandRunner } from "../runner.ts";

export type ScriptedCommand = "bd" | "git" | "gh" | "claude";

export interface ScriptedAnswer {
  command: ScriptedCommand;
  /** The row answers a call whose argv, after the command, starts with these args. */
  args: readonly string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface RecordedCall extends CommandOptions {
  argv: string[];
}

export interface FakeRunner extends CommandRunner {
  readonly calls: RecordedCall[];
}

/** Builds a runner from a table of scripted answers. A call no row scripts rejects with the argv. */
export function fakeRunner(table: readonly ScriptedAnswer[]): FakeRunner {
  const calls: RecordedCall[] = [];
  const runner = async (argv: readonly string[], options: CommandOptions = {}): Promise<CommandResult> => {
    calls.push({ argv: [...argv], ...options });
    const [command, ...args] = argv;
    const row = table.find((r) => r.command === command && r.args.every((arg, i) => args[i] === arg));
    if (!row) throw new Error(`Unexpected command: ${argv.join(" ")}`);
    return { stdout: row.stdout ?? "", stderr: row.stderr ?? "", exitCode: row.exitCode ?? 0 };
  };
  return Object.assign(runner, { calls });
}
