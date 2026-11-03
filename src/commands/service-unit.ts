// What `kitchen up` and `kitchen down` share: the unit for this host's platform, or the refusal, and
// running the service manager's commands in order, stopping at the first that fails.
import type { CliDeps } from "../cli.ts";
import { serviceUnit, ServiceError } from "../expeditor/service.ts";
import type { ServiceSpec, ServiceUnit } from "../expeditor/service.ts";

/** The unit for this host; `kitchen down` passes no settings, since it only needs the file and the stop commands. */
export function unitFor(deps: CliDeps, settings?: Pick<ServiceSpec, "interval" | "port">): ServiceUnit | { error: string } {
  try {
    return serviceUnit({ program: deps.program, host: deps.hostname, env: deps.env, ...settings });
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    throw error;
  }
}

/** Runs each command; the first that exits non-zero is reported under the command's name and ends the run. */
export async function runEach(deps: CliDeps, command: string, commands: readonly (readonly string[])[]): Promise<boolean> {
  for (const argv of commands) {
    const result = await deps.runner(argv);
    if (result.exitCode !== 0) {
      deps.stderr(`kitchen ${command}: ${argv.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}\n`);
      return false;
    }
  }
  return true;
}
