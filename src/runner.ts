// The one external process seam: argv in; stdout, stderr and exit code out.
import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Environment entries laid over the process environment. */
  env?: Record<string, string>;
}

export type CommandRunner = (argv: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

/** Runs the command as a child process. A command that cannot start answers with exit code 127. */
export const processRunner: CommandRunner = (argv, options = {}) =>
  new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve({ stdout: "", stderr: "empty argv", exitCode: 127 });
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => resolve({ stdout, stderr: `${stderr}${error.message}\n`, exitCode: 127 }));
    child.on("close", (code, signal) => resolve({ stdout, stderr, exitCode: code ?? (signal ? 128 : 1) }));
  });
