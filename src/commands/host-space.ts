// The space a command on this host writes to: opened from the config `kitchen init` wrote, under the
// actor of the context (the owner at a terminal, the station or the expeditor in a session Kitchen started).
import { actorName, resolveActor } from "../actor.ts";
import type { CliDeps } from "../cli.ts";
import { hostConfigFile, readHostConfig } from "../config.ts";
import type { HostConfig } from "../config.ts";
import { openSpace } from "../space.ts";
import type { Space } from "../space.ts";

export function openHostSpace(deps: CliDeps): { space: Space; config: HostConfig } | { error: string } {
  const config = readHostConfig(deps.env);
  if (!config) return { error: `no host config at ${hostConfigFile(deps.env)}: run kitchen init first` };
  const actor = resolveActor(deps.env, config);
  return { space: openSpace({ runner: deps.runner, env: deps.env, config, actor }), config };
}

/**
 * The space a registration (`station add`, `source add`) writes to: a human act, so only the owner's
 * bare actor. A station is refused by the wrapper itself, which refuses it every registered-type write;
 * the expeditor is not (it keeps a source's cursor), so a registration refuses it here.
 */
export function openRegistrationSpace(deps: CliDeps, what: string): { space: Space; config: HostConfig } | { error: string } {
  const opened = openHostSpace(deps);
  if ("error" in opened) return opened;
  if (opened.space.actor.kind === "expeditor") {
    return { error: `${actorName(opened.space.actor)} may not register a ${what}: registration is a human act (a cooperative rule: docs/trust-model.md)` };
  }
  return opened;
}
