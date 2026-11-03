// Worktrees per order per repository (spec: Worktrees, handoff and merge gate; ADR 0005). One worktree
// per repository the order names, under `<station checkout>/.kitchen/worktrees/<order>` on branch
// `kitchen/<order>`: created at the first code-touching phase from the remote branch when another
// host's turn pushed one, else from the checkout's base branch; reused after; removed on a later
// tick once the order is closed. The worktree's own git config carries the owner as author and the
// hook that adds the `Kitchen-Station:` trailer, so commits made in a turn read as the owner's and
// name the station. Everything git is one command at a time through the runner.
import fs from "node:fs";
import path from "node:path";
import type { CommandResult, CommandRunner } from "../runner.ts";
import type { Station } from "../station.ts";

/** The directory under a station checkout that Kitchen owns: the worktrees and the hooks. */
export const KITCHEN_DIR = ".kitchen";

/** The worktree policy under which a runner works in a worktree per order. */
export const PER_ORDER = "per-order";

/** The trailer every commit made in a turn carries, naming the station. */
export const STATION_TRAILER = "Kitchen-Station";

export const orderBranch = (order: string): string => `kitchen/${order}`;

export const worktreePath = (checkout: string, order: string): string => path.join(checkout, KITCHEN_DIR, "worktrees", order);

export const hooksPath = (checkout: string): string => path.join(checkout, KITCHEN_DIR, "hooks");

/** A station checkout of one repository, as the launch spec lists it. */
export interface Checkout {
  slug: string;
  path: string;
}

export interface Worktree {
  slug: string;
  /** The station checkout it lives in. */
  checkout: string;
  path: string;
}

/** A git command that failed; the message names the command, the exit code and what git said. */
export class WorktreeError extends Error {
  constructor(argv: readonly string[], result: CommandResult) {
    super(`${argv.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "WorktreeError";
  }
}

/**
 * The hook `core.hooksPath` points a worktree at. It runs the repository's own hook first, so what
 * beads or the project installed under `.git/hooks` keeps running in the worktree, then adds the
 * trailer naming the station the worktree's own config carries.
 */
export const TRAILER_HOOK = `#!/bin/sh
# Kitchen: runs the repository's own prepare-commit-msg hook, then adds the ${STATION_TRAILER} trailer.
hooks="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$hooks/prepare-commit-msg" ]; then "$hooks/prepare-commit-msg" "$@" || exit $?; fi
station=$(git config kitchen.station) || exit 0
git interpret-trailers --in-place --if-exists doNothing --trailer "${STATION_TRAILER}: $station" "$1"
`;

/**
 * The worktree of one order in one checkout, created when it is not there yet. Creation fetches the
 * remote and checks out the remote `kitchen/<order>` branch when it exists, else branches from the
 * checkout's upstream (its HEAD when it tracks nothing); reuse fast-forwards the remote branch in.
 * The station gives the commit identity: its owner as author, its title in the trailer.
 */
export async function ensureWorktree(runner: CommandRunner, checkout: Checkout, order: string, station: Pick<Station, "owner" | "title">): Promise<Worktree> {
  const git = gitIn(runner);
  const branch = orderBranch(order);
  const worktree: Worktree = { slug: checkout.slug, checkout: checkout.path, path: worktreePath(checkout.path, order) };
  const remote = `origin/${branch}`;
  await git(checkout.path, ["fetch", "origin"]);
  const pushed = (await git(checkout.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}`], { tolerate: true })).exitCode === 0;
  if (fs.existsSync(worktree.path)) {
    if (pushed) await git(worktree.path, ["merge", "--ff-only", remote]);
    return worktree;
  }
  if (pushed) {
    await git(checkout.path, ["worktree", "add", "--track", "-b", branch, worktree.path, remote]);
  } else {
    const upstream = await git(checkout.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { tolerate: true });
    const base = upstream.exitCode === 0 ? upstream.stdout.trim() : "HEAD";
    await git(checkout.path, ["worktree", "add", "-b", branch, worktree.path, base]);
  }
  // Per-worktree config wants the extension on the repository; the main checkout's identity is untouched.
  await git(checkout.path, ["config", "extensions.worktreeConfig", "true"]);
  await git(worktree.path, ["config", "--worktree", "user.name", station.owner]);
  await git(worktree.path, ["config", "--worktree", "kitchen.station", station.title]);
  await git(worktree.path, ["config", "--worktree", "core.hooksPath", hooksPath(checkout.path)]);
  writeTrailerHook(checkout.path);
  return worktree;
}

/** The order ids with a worktree under the checkout, as the directory names them. */
export function worktreeOrders(checkout: string): string[] {
  const dir = path.join(checkout, KITCHEN_DIR, "worktrees");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** Removes the order's worktree from the checkout with its branch; the remote branch is the closing turn's. */
export async function removeWorktree(runner: CommandRunner, checkout: string, order: string): Promise<string> {
  const git = gitIn(runner);
  const target = worktreePath(checkout, order);
  await git(checkout, ["worktree", "remove", "--force", target]);
  await git(checkout, ["branch", "-D", orderBranch(order)]);
  return target;
}

function writeTrailerHook(checkout: string): void {
  const dir = hooksPath(checkout);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prepare-commit-msg"), TRAILER_HOOK, { mode: 0o755 });
}

/** `git -C <dir> ...`; a non-zero exit throws unless the call tolerates one (a check, not a change). */
function gitIn(runner: CommandRunner) {
  return async (dir: string, args: readonly string[], options: { tolerate?: boolean } = {}): Promise<CommandResult> => {
    const argv = ["git", "-C", dir, ...args];
    const result = await runner(argv);
    if (result.exitCode !== 0 && !options.tolerate) throw new WorktreeError(argv, result);
    return result;
  };
}
