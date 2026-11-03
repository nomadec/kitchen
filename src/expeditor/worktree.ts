// Worktrees per order per repository (spec: Worktrees, handoff and merge gate; ADR 0005). One worktree
// per repository the order names, under `<station checkout>/.kitchen/worktrees/<order>` on branch
// `kitchen/<order>`: created at the first code-touching phase from the remote branch when another
// host's turn pushed one, else from the checkout's base branch; reused after; removed on a later
// tick once the order is closed. The worktree's own git config carries the owner as author (the email
// stays the checkout's own) and a hooks directory that forwards every hook to the repository's own and
// adds the `Kitchen-Station:` trailer, so commits made in a turn read as the owner's, name the station
// and still run what the project installed. Everything git is one command at a time through the runner.
import fs from "node:fs";
import path from "node:path";
import { GitError, gitIn } from "../git.ts";
import type { CommandRunner } from "../runner.ts";
import type { Station } from "../station.ts";

export { GitError as WorktreeError };

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


/**
 * The client-side hooks git runs, each of which the worktree's hooks directory forwards to the
 * repository's own hook of that name, so pointing `core.hooksPath` at it disables nothing the project
 * or beads installed.
 */
export const FORWARDED_HOOKS: readonly string[] = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite",
  "pre-auto-gc", "post-index-change", "reference-transaction", "sendemail-validate",
];

/**
 * The lines every hook under `.kitchen/hooks` starts with: find the repository's own hooks directory
 * (its `core.hooksPath` in the repository's config, else the global one, else the system one, else
 * `.git/hooks`; read as a path, so a `~/` value is expanded as git expands it, while a relative path
 * stays relative, since git runs a hook from the root of the working tree and reads a relative
 * `core.hooksPath` from there) and run the hook of the same name there when it exists.
 */
const FORWARD = `#!/bin/sh
# Kitchen: runs the repository's own hook of this name, so the worktree keeps every hook the project or beads installed.
common="$(git rev-parse --git-common-dir)"
hooks="$(git config --type=path --file "$common/config" core.hooksPath 2>/dev/null || git config --type=path --global core.hooksPath 2>/dev/null || git config --type=path --system core.hooksPath 2>/dev/null || echo "$common/hooks")"
name="$(basename "$0")"
if [ -x "$hooks/$name" ]; then "$hooks/$name" "$@" || exit $?; fi
`;

/** The prepare-commit-msg hook: the forward, then the trailer naming the station the worktree's own config carries. */
export const TRAILER_HOOK = `${FORWARD}station=$(git config kitchen.station) || exit 0
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
  // Written on every turn, reused worktree or not, so the hooks are the ones this version forwards.
  writeTrailerHook(checkout.path);
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

/**
 * Writes the forwarding hooks and the trailer hook under the checkout's `.kitchen/hooks`. The directory
 * is shared by every worktree of the checkout and written on every turn, so each hook lands by a rename:
 * a commit of another turn reading it meanwhile sees the whole old file or the whole new one.
 */
function writeTrailerHook(checkout: string): void {
  const dir = hooksPath(checkout);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of FORWARDED_HOOKS) {
    const staged = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(staged, name === "prepare-commit-msg" ? TRAILER_HOOK : FORWARD, { mode: 0o755 });
    fs.renameSync(staged, path.join(dir, name));
  }
}

