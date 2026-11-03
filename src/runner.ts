// The one external process seam: argv in; stdout, stderr and exit code out.
import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  /** `inherit` attaches the child to this process's terminal: an interactive turn. Its output is then not captured. */
  stdio?: "inherit";
  /** Working directory for the command. */
  cwd?: string;
  /** Environment entries laid over the process environment. */
  env?: Record<string, string>;
  /** Kills the child when aborted: the wall-clock timeout of a turn. The result then carries the signal's exit code. */
  signal?: AbortSignal;
}

export type CommandRunner = (argv: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

/** The exit code of a child a signal ended, as a shell reports it. */
export const KILLED_EXIT_CODE = 128;

/** Runs the command as a child process. A command that cannot start answers with exit code 127. */
export const processRunner: CommandRunner = (argv, options = {}) =>
  options.stdio === "inherit" ? attachedRunner(argv, options) : new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve({ stdout: "", stderr: "empty argv", exitCode: 127 });
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      // An abort kills the child; its close event carries the signal.
      if (error.name !== "AbortError") resolve({ stdout, stderr: `${stderr}${error.message}\n`, exitCode: 127 });
    });
    child.on("close", (code, signal) => resolve({ stdout, stderr, exitCode: code ?? (signal ? KILLED_EXIT_CODE : 1) }));
  });

/** Runs the command attached to this process's terminal; the result's stdout and stderr are empty. */
const attachedRunner: CommandRunner = (argv, options = {}) =>
  new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve({ stdout: "", stderr: "empty argv", exitCode: 127 });
      return;
    }
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
    child.on("error", (error) => resolve({ stdout: "", stderr: `${error.message}\n`, exitCode: 127 }));
    child.on("close", (code, signal) => resolve({ stdout: "", stderr: "", exitCode: code ?? (signal ? 128 : 1) }));
  });
