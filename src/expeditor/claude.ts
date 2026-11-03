// The runner: one function from launch spec, phase and mode to a child process handle. The v1 runner
// spawns the claude CLI in the Claude Code harness with the Kitchen plugin and the station's plugins,
// the turn driver as the prompt, the station's checkout as the working directory, the actor and the
// space connection in the environment, and the harness flags for model, effort and (headless only)
// the print flag and the dollar cap. A Codex runner would be a second implementation of TurnRunner.
import { beadsDir } from "../config.ts";
import type { HostConfig } from "../config.ts";
import type { LaidPhase } from "../laid.ts";
import type { Order } from "../order.ts";
import type { CommandResult, CommandRunner } from "../runner.ts";
import type { LaunchSpec } from "../station.ts";

/** Headless on an unattended station; interactive in the human's terminal on an attended one. */
export type TurnMode = "headless" | "interactive";

export interface TurnRequest {
  launch: LaunchSpec;
  phase: LaidPhase;
  mode: TurnMode;
  /** The phase's order: its repositories decide the working directory. */
  order: Order;
}

/** A running turn: what was spawned, and its result when the child exits. */
export interface TurnHandle {
  argv: readonly string[];
  cwd?: string;
  env: Record<string, string>;
  done: Promise<CommandResult>;
}

export type TurnRunner = (request: TurnRequest) => TurnHandle;

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
    const cwd = checkoutFor(request.launch, request.order);
    const env = {
      // The station title is the turn actor (spec: Store, Actors).
      BEADS_ACTOR: request.phase.station,
      BEADS_DIR: beadsDir(deps.env),
      BEADS_CREDENTIALS_FILE: deps.config.credential,
    };
    const handle: TurnHandle = { argv, env, done: deps.runner(argv, cwd === undefined ? { env } : { cwd, env }) };
    if (cwd !== undefined) handle.cwd = cwd;
    return handle;
  };
}

function claudeArgv(pluginDir: string, { launch, phase, mode }: TurnRequest): string[] {
  const plugins = [pluginDir, ...launch.plugins].flatMap((dir) => ["--plugin-dir", dir]);
  // A headless session has no one to answer a permission prompt, so it runs with permissions skipped;
  // guard hooks that block risky actions are out of v1's scope. An interactive session asks the human.
  const headless = mode === "headless" ? ["--print", "--effort", phase.budget.effort, "--max-budget-usd", String(phase.budget.usd), "--dangerously-skip-permissions"] : ["--effort", phase.budget.effort];
  return ["claude", "--model", phase.model, ...plugins, ...headless, turnPrompt(phase.id)];
}

/**
 * The working directory: until worktrees come, the station's checkout of the first repository the order
 * names that the station offers, else the station's first checkout.
 */
function checkoutFor(launch: LaunchSpec, order: Order): string | undefined {
  const named = order.repos.map((slug) => launch.repositories.find((r) => r.slug === slug)).find((r) => r !== undefined);
  return (named ?? launch.repositories[0])?.path;
}
