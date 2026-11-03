// The merge gate (spec: Worktrees, handoff and merge gate; story 76): the helper a recipe's merge phase
// calls from the order's worktree. It fetches the base branch, brings the order's branch up to date with
// it, runs the verify commands the repository lists in its VERIFY file in order, records the verified
// revision, the base revision and the combined output as a note on the phase bead, and merges the pull
// request only while its head is still the verified revision and the base has not moved; otherwise it
// verifies again. A verified revision is evidence for that revision only. After the merge it deletes the
// remote branch. Everything external is one command at a time through the runner.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliDeps } from "./cli.ts";
import { openHostSpace } from "./commands/host-space.ts";
import { GitError, gitIn } from "./git.ts";
import type { CommandResult } from "./runner.ts";
import { SpaceError } from "./space.ts";
import type { BeadRef, Space } from "./space.ts";

/** The file at the repository root that lists the verify commands, one per line. */
export const VERIFY_FILE = "VERIFY";

/** How many times the gate verifies when the head or the base keeps moving, before it refuses. */
const ROUNDS = 3;

/** How much of one command's output the note keeps: its tail. */
const OUTPUT_TAIL = 4000;

type UpdateConvention = "merge" | "rebase";
type PullRequestMethod = "merge" | "squash" | "rebase";

/** What the VERIFY file says: the commands, and the two conventions it may state. */
interface VerifyFile {
  commands: string[];
  update: UpdateConvention;
  pr: PullRequestMethod;
}

export interface MergeGateDeps extends Pick<CliDeps, "runner" | "clock" | "env" | "stdout" | "stderr"> {
  /** The order's worktree the helper is called from. */
  cwd: string;
}

const USAGE = `Usage: merge-gate <phase>

Run from the order's worktree by the merge phase. Fetches the base branch of the branch's pull request,
brings the branch up to date with it (merge, or rebase when the repository's ${VERIFY_FILE} file says
\`update: rebase\`), runs the commands listed in ${VERIFY_FILE} in order, records the verified revision,
the base revision and the output as a note on the phase, and merges the pull request only while its
head is still that revision and the base has not moved; otherwise it verifies again, up to ${ROUNDS}
times. After the merge the remote branch is deleted. Exits 0 on a merge, 1 on a refusal.
`;

interface PullRequest {
  number: number;
  url: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
}

/** A refusal: nothing merged. The note, when there is one, was recorded before this is thrown. */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/** The helper's entry: the argv after the script, the deps the bin wires. Resolves to the exit code. */
export async function mergeGate(args: readonly string[], deps: MergeGateDeps): Promise<number> {
  const fail = (message: string, usage = false): number => {
    deps.stderr(`merge-gate: ${message}\n${usage ? `\n${USAGE}` : ""}`);
    return 1;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), true);
  }
  const [id, ...more] = positionals;
  if (id === undefined) return fail("a phase id is required", true);
  if (more.length) return fail(`one phase at a time, got ${positionals.join(" ")}`, true);

  const opened = openHostSpace(deps);
  if ("error" in opened) return fail(opened.error, true);
  const { space } = opened;

  try {
    const phase = await space.show(id);
    const gate = await Gate.open(deps, space, phase);
    const merged = await gate.run();
    deps.stdout(`merge-gate: merged ${merged.url} at ${merged.revision} on base ${merged.base}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Refusal || error instanceof SpaceError || error instanceof GitError) return fail(error.message);
    throw error;
  }
}

/** Reads the VERIFY file: blank lines and `#` comments skipped, `update:` and `pr:` lines as conventions, the rest commands. */
function parseVerifyFile(text: string): VerifyFile {
  const file: VerifyFile = { commands: [], update: "merge", pr: "merge" };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const update = /^update:\s*(\S+)$/.exec(line);
    if (update) {
      const value = update[1];
      if (value !== "merge" && value !== "rebase") throw new Refusal(`${VERIFY_FILE} says update: ${value}; it must be merge or rebase`);
      file.update = value;
      continue;
    }
    const pr = /^pr:\s*(\S+)$/.exec(line);
    if (pr) {
      const value = pr[1];
      if (value !== "merge" && value !== "squash" && value !== "rebase") throw new Refusal(`${VERIFY_FILE} says pr: ${value}; it must be merge, squash or rebase`);
      file.pr = value;
      continue;
    }
    file.commands.push(line);
  }
  return file;
}

const NO_FILE: VerifyFile = { commands: [], update: "merge", pr: "merge" };

interface Verified {
  revision: string;
  base: string;
  /** The combined output of what ran, each under its own line and over its `exit <n>` line. */
  output: string;
  method: PullRequestMethod;
}

/** One run of the gate on one worktree and the open pull request of its branch. */
class Gate {
  private readonly deps: MergeGateDeps;
  private readonly space: Space;
  private readonly phase: BeadRef;
  private readonly git: ReturnType<typeof gitHere>;
  private readonly branch: string;
  private pr: PullRequest;
  /** The last revision and base read, named by the note of a refusal that comes from git or gh itself. */
  private last: Pick<Verified, "revision" | "base">;

  private constructor(deps: MergeGateDeps, space: Space, phase: BeadRef, branch: string, pr: PullRequest) {
    this.deps = deps;
    this.space = space;
    this.phase = phase;
    this.git = gitHere(deps);
    this.branch = branch;
    this.pr = pr;
    this.last = { revision: pr.headRefOid, base: "not fetched" };
  }

  /** Reads the worktree's branch and its open pull request; without one there is nothing to gate and no note. */
  static async open(deps: MergeGateDeps, space: Space, phase: BeadRef): Promise<Gate> {
    const git = gitHere(deps);
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const pr = await prView(deps, ["number", "url", "state", "baseRefName", "headRefName", "headRefOid"]);
    if (pr.state !== "OPEN") throw new Refusal(`the pull request ${pr.url} is ${pr.state.toLowerCase()}, not open`);
    if (pr.headRefName !== branch) throw new Refusal(`the pull request ${pr.url} is for ${pr.headRefName}, not the worktree's branch ${branch}`);
    return new Gate(deps, space, phase, branch, pr);
  }

  /** Verifies, and merges when nothing moved; a refusal from git or gh itself is noted here, with the revisions last read. */
  async run(): Promise<{ url: string; revision: string; base: string }> {
    try {
      return await this.rounds();
    } catch (error) {
      if (error instanceof GitError || (error instanceof Refusal && !error.message.startsWith("refused, "))) {
        await this.note(`refused, ${error.message}`, { ...this.last, output: "", method: "merge" });
        throw new Refusal(`refused, ${error.message}`);
      }
      throw error;
    }
  }

  private async rounds(): Promise<{ url: string; revision: string; base: string }> {
    let stale = "";
    let verified: Verified | undefined;
    for (let round = 1; round <= ROUNDS; round++) {
      verified = await this.verify();
      stale = (await this.moved(verified)) ?? "";
      if (stale === "") return this.merge(verified);
      await this.note(`stale, ${stale} after the verify`, verified);
      this.deps.stderr(`merge-gate: ${stale} after the verify of ${verified.revision}: verifying again\n`);
    }
    return this.refuse(`still stale after ${ROUNDS} verifies: ${stale}`, verified as Verified);
  }

  /**
   * Fetches, fast-forwards the worktree to the pull request's head when someone pushed past it, brings
   * the branch up to date with the base, pushes what that made, and runs the commands the branch lists
   * after the update, so the list verified is the revision's own.
   */
  private async verify(): Promise<Verified> {
    const base = this.pr.baseRefName;
    await this.git(["fetch", "origin"]);
    const baseRevision = (await this.git(["rev-parse", `origin/${base}`])).stdout.trim();
    this.last = { revision: this.pr.headRefOid, base: baseRevision };
    if ((await this.head()) !== this.pr.headRefOid) {
      const forwarded = await this.git(["merge", "--ff-only", `origin/${this.branch}`], { tolerate: true });
      if (forwarded.exitCode !== 0) {
        return this.refuse(`the worktree diverged from the pull request head ${this.pr.headRefOid}`, { ...this.last, output: combined(`$ git merge --ff-only origin/${this.branch}`, forwarded), method: "merge" });
      }
    }
    const convention = this.readVerifyFile().update;
    const update = convention === "rebase" ? ["rebase", `origin/${base}`] : ["merge", "--no-edit", `origin/${base}`];
    const updated = await this.git(update, { tolerate: true });
    if (updated.exitCode !== 0) {
      await this.git([convention, "--abort"], { tolerate: true });
      const what = convention === "rebase" ? `the rebase onto origin/${base}` : `the merge of origin/${base}`;
      return this.refuse(`${what} conflicted`, { revision: await this.head(), base: baseRevision, output: combined(`$ git ${update.join(" ")}`, updated), method: "merge" });
    }
    const revision = await this.head();
    this.last = { revision, base: baseRevision };
    if (revision !== this.pr.headRefOid) {
      await this.git(convention === "rebase" ? ["push", "--force-with-lease", "origin", this.branch] : ["push", "origin", this.branch]);
      this.pr = { ...this.pr, headRefOid: revision };
    }
    const file = this.readVerifyFile();
    if (file === NO_FILE) return this.refuse(`no ${VERIFY_FILE} file in the repository`, { revision, base: baseRevision, output: "", method: file.pr });
    const outputs: string[] = [];
    for (const command of file.commands) {
      const result = await this.deps.runner(["sh", "-c", command], { cwd: this.deps.cwd });
      outputs.push(combined(`$ ${command}`, result));
      if (result.exitCode !== 0) {
        return this.refuse(`${command} exited ${result.exitCode}`, { revision, base: baseRevision, output: outputs.join("\n"), method: file.pr });
      }
    }
    const verified = { revision, base: baseRevision, output: outputs.join("\n"), method: file.pr };
    await this.note("verified", verified);
    return verified;
  }

  /** What moved since the verify, if anything: the pull request's head, or the base on the remote. */
  private async moved(verified: Verified): Promise<string | undefined> {
    const head = await prView(this.deps, ["headRefOid", "state"]);
    if (head.state !== "OPEN") throw new Refusal(`the pull request ${this.pr.url} is ${head.state.toLowerCase()}, not open`);
    if (head.headRefOid !== verified.revision) {
      this.pr = { ...this.pr, headRefOid: head.headRefOid };
      return `the pull request head moved to ${head.headRefOid}`;
    }
    const remote = (await this.git(["ls-remote", "origin", `refs/heads/${this.pr.baseRefName}`])).stdout.split(/\s/)[0] ?? "";
    if (remote !== verified.base) return `the base moved to ${remote}`;
    return undefined;
  }

  /** Merges the verified revision, GitHub refusing a head that moved in between, then deletes the remote branch. */
  private async merge(verified: Verified): Promise<{ url: string; revision: string; base: string }> {
    await gh(this.deps, ["pr", "merge", String(this.pr.number), `--${verified.method}`, "--match-head-commit", verified.revision]);
    // Merged: the pull request is closed, so a branch GitHub deleted itself, or a delete that fails, is reported and not a refusal.
    const deleted = await this.git(["push", "origin", "--delete", this.branch], { tolerate: true });
    const outcome = deleted.exitCode === 0 ? `remote branch ${this.branch} deleted` : `remote branch ${this.branch} not deleted: ${deleted.stderr.trim()}`;
    await this.note(`merged ${this.pr.url}`, { ...verified, output: outcome });
    if (deleted.exitCode !== 0) this.deps.stderr(`merge-gate: ${outcome}\n`);
    return { url: this.pr.url, revision: verified.revision, base: verified.base };
  }

  private async head(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  /** The VERIFY file as the worktree holds it now, or the no-file marker. */
  private readVerifyFile(): VerifyFile {
    const file = path.join(this.deps.cwd, VERIFY_FILE);
    return fs.existsSync(file) ? parseVerifyFile(fs.readFileSync(file, "utf8")) : NO_FILE;
  }

  /** Records the outcome and throws it: every outcome names the revision and the base. */
  private async refuse(reason: string, verified: Verified): Promise<never> {
    await this.note(`refused, ${reason}`, verified);
    throw new Refusal(`refused, ${reason} (revision ${verified.revision}, base ${verified.base})`);
  }

  private async note(outcome: string, verified: Verified): Promise<void> {
    const lines = [`merge gate: ${outcome}`, `revision: ${verified.revision}`, `base: ${verified.base}`, `at: ${this.deps.clock.now().toISOString()}`];
    if (verified.output !== "") lines.push(verified.output);
    await this.space.update(this.phase, { appendNotes: lines.join("\n") });
  }
}

/** The pull request of the worktree's branch, the fields asked for, as `gh pr view --json` answers from the worktree. */
async function prView<K extends keyof PullRequest>(deps: MergeGateDeps, fields: readonly K[]): Promise<Pick<PullRequest, K>> {
  return JSON.parse((await gh(deps, ["pr", "view", "--json", fields.join(",")])).stdout) as Pick<PullRequest, K>;
}

/** `gh` from the worktree, so it resolves the branch's pull request; a non-zero exit throws what gh said. */
async function gh(deps: MergeGateDeps, args: readonly string[]): Promise<CommandResult> {
  const argv = ["gh", ...args];
  const result = await deps.runner(argv, { cwd: deps.cwd });
  if (result.exitCode !== 0) throw new GitError(argv, result);
  return result;
}

/** `git -C <worktree> ...`: the shared git seam bound to the worktree the helper runs from. */
function gitHere(deps: Pick<MergeGateDeps, "runner" | "cwd">) {
  const git = gitIn(deps.runner);
  return (args: readonly string[], options: { tolerate?: boolean } = {}): Promise<CommandResult> => git(deps.cwd, args, options);
}

/** The recorded form of one result: the line that names what ran, the tail of its output, the exit code. */
function combined(label: string, result: CommandResult): string {
  const output = `${result.stdout}${result.stderr}`;
  const tail = output.length > OUTPUT_TAIL ? `(${output.length - OUTPUT_TAIL} characters elided)\n${output.slice(-OUTPUT_TAIL)}` : output;
  return `${label}\n${tail}${tail === "" || tail.endsWith("\n") ? "" : "\n"}exit ${result.exitCode}`;
}


