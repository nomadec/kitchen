// The one git seam the worktrees and the merge gate share: `git -C <dir> ...` through the runner, with
// a non-zero exit as an error naming the command and what it said.
import type { CommandResult, CommandRunner } from "./runner.ts";

/** A git or gh command that failed; the message names the command, the exit code and what it said. */
export class GitError extends Error {
  constructor(argv: readonly string[], result: CommandResult) {
    super(`${argv.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GitError";
  }
}

/** `git -C <dir> ...`; a non-zero exit throws unless the call tolerates one (a check, not a change). */
export function gitIn(runner: CommandRunner) {
  return async (dir: string, args: readonly string[], options: { tolerate?: boolean } = {}): Promise<CommandResult> => {
    const argv = ["git", "-C", dir, ...args];
    const result = await runner(argv);
    if (result.exitCode !== 0 && !options.tolerate) throw new GitError(argv, result);
    return result;
  };
}
