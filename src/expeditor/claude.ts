// The runner: one function from launch spec, phase and mode to a child process handle. The v1 runner
// spawns the claude CLI in the Claude Code harness with the Kitchen plugin and the station's plugins,
// the turn driver as the prompt, the order's worktree (else the station's checkout) as the working
// directory, the actor and the space connection in the environment, and the harness flags for model, effort and (headless only)
// the print flag and the dollar cap. The secrets the launch spec names are resolved on this host into
// the child's environment, from the expeditor's own environment or the host's secret files, and never
// read into the space. A Codex runner would be a second implementation of TurnRunner.
import fs from "node:fs";
import path from "node:path";
import { beadsDir, kitchenConfigDir } from "../config.ts";
import type { HostConfig } from "../config.ts";
import type { LaidPhase } from "../laid.ts";
import type { Order } from "../order.ts";
import type { CommandResult, CommandRunner } from "../runner.ts";
import { offeredCheckouts } from "../station.ts";
import type { LaunchSpec } from "../station.ts";
import type { Worktree } from "./worktree.ts";

/** Headless on an unattended station; interactive in the human's terminal on an attended one. */
export type TurnMode = "headless" | "interactive";

export interface TurnRequest {
  launch: LaunchSpec;
  phase: LaidPhase;
  mode: TurnMode;
  /** The phase's order: its repositories decide the working directory. */
  order: Order;
  /** The order's worktrees in the station's checkouts, when the phase touches code under the per-order policy. */
  worktrees: Worktree[];
}

/** A running turn: what was spawned, its result when the child exits, and the way to end it first. */
export interface TurnHandle {
  argv: readonly string[];
  cwd?: string;
  env: Record<string, string>;
  done: Promise<CommandResult>;
  /** Kills the child: the station's wall-clock timeout. `done` then settles with the signal's exit code. */
  kill(): void;
}

/** A runner spawns the child, or throws this before any spawn when the launch cannot be made: a secret the host does not hold. */
export type TurnRunner = (request: TurnRequest) => TurnHandle;

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

/** Where a host keeps a secret by name when it is not in the environment: one file per name, the value its content. */
export function secretFile(env: Record<string, string | undefined>, name: string): string {
  return path.join(kitchenConfigDir(env), "secrets", name);
}

/**
 * The value of each secret the launch spec names, from the environment first, then the host's secret
 * file; a name resolved nowhere refuses the launch, naming the file that would hold it.
 */
export function resolveSecrets(env: Record<string, string | undefined>, names: readonly string[]): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const name of names) {
    const fromEnv = env[name];
    if (fromEnv !== undefined && fromEnv !== "") {
      resolved[name] = fromEnv;
      continue;
    }
    const file = secretFile(env, name);
    const fromFile = readSecretFile(name, file);
    if (fromFile === "") throw new LaunchError(`secret ${name} is not set: the station names it, and this host holds it neither in the environment nor at ${file}`);
    resolved[name] = fromFile;
  }
  return resolved;
}

/** The secret file's content without its final newline; empty when there is no file, a LaunchError when there is one that cannot be read (its mode, a directory). */
function readSecretFile(name: string, file: string): string {
  try {
    return fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw new LaunchError(`secret ${name} cannot be read from ${file}: ${code ?? String(error)}`);
  }
}

export interface ClaudeRunnerDeps {
  runner: CommandRunner;
  env: Record<string, string | undefined>;
  config: HostConfig;
  /** The Kitchen plugin directory: the turn driver and the Stop hook. */
  pluginDir: string;
}

export const KITCHEN_TURN_SKILL = "kitchen:turn";

/** The first message of every session: the turn driver, reached through the Skill tool once the plugin has loaded. */
export const turnPrompt = (phaseId: string): string => `Invoke the Skill tool with skill "${KITCHEN_TURN_SKILL}" and args "${phaseId}"`;

export function claudeRunner(deps: ClaudeRunnerDeps): TurnRunner {
  return (request) => {
    const argv = claudeArgv(deps.pluginDir, request);
    const cwd = workingDirectory(request);
    const env = {
      ...resolveSecrets(deps.env, request.launch.secrets),
      // The station title is the turn actor (spec: Store, Actors).
      BEADS_ACTOR: request.phase.station,
      BEADS_DIR: beadsDir(deps.env),
      BEADS_CREDENTIALS_FILE: deps.config.credential,
    };
    const killer = new AbortController();
    const handle: TurnHandle = {
      argv,
      env,
      done: deps.runner(argv, { ...(cwd === undefined ? {} : { cwd }), env, signal: killer.signal }),
      kill: () => killer.abort(),
    };
    if (cwd !== undefined) handle.cwd = cwd;
    return handle;
  };
}

function claudeArgv(pluginDir: string, { launch, phase, mode }: TurnRequest): string[] {
  const plugins = [pluginDir, ...launch.plugins].flatMap((dir) => ["--plugin-dir", dir]);
  // A headless session has no one to answer a permission prompt, so it runs with permissions skipped
  // (docs/trust-model.md says what that widens); guard hooks that block risky actions are out of v1's
  // scope. An interactive session asks the human.
  const headless = mode === "headless" ? ["--print", "--effort", phase.budget.effort, "--max-budget-usd", String(phase.budget.usd), "--dangerously-skip-permissions"] : ["--effort", phase.budget.effort];
  return ["claude", "--model", phase.model, ...plugins, ...headless, turnPrompt(phase.id)];
}

/**
 * The working directory: the order's worktree in the checkout of the first repository the order names
 * that the station offers; without worktrees, that checkout itself, else the station's first checkout.
 */
function workingDirectory({ launch, order, worktrees }: TurnRequest): string | undefined {
  const [named] = offeredCheckouts(launch, order.repos);
  if (named) return worktrees.find((w) => w.slug === named.slug)?.path ?? named.path;
  return launch.repositories[0]?.path;
}
