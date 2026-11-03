// The host config: where this host finds the space and who it writes as.
import fs from "node:fs";
import path from "node:path";

export interface SpaceServer {
  host: string;
  port: number;
  /** The SQL user: one per person, used by that person and their stations. */
  user: string;
  database: string;
}

export interface HostConfig {
  server: SpaceServer;
  /** Credential reference: the beads credentials file whose `[host:port]` section holds the password. */
  credential: string;
  /** The person this host's stations belong to; the bare human actor. */
  owner: string;
  /** The name stations registered on this host carry in their `host:` label. */
  host: string;
}

type Env = Record<string, string | undefined>;

/** The user's config root: `$XDG_CONFIG_HOME`, else `~/.config`. */
export function userConfigRoot(env: Env): string {
  return env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? "", ".config");
}

export function kitchenConfigDir(env: Env): string {
  return path.join(userConfigRoot(env), "kitchen");
}

export function hostConfigFile(env: Env): string {
  return path.join(kitchenConfigDir(env), "config.json");
}

/** The beads workspace this host runs every `bd` command from. */
export function spaceDir(env: Env): string {
  return path.join(kitchenConfigDir(env), "space");
}

/** The `.beads` directory of the space: what `BEADS_DIR` points a session at from any working directory. */
export function beadsDir(env: Env): string {
  return path.join(spaceDir(env), ".beads");
}

/** The user's state root: `$XDG_STATE_HOME`, else `~/.local/state`. */
export function userStateRoot(env: Env): string {
  return env.XDG_STATE_HOME ?? path.join(env.HOME ?? "", ".local", "state");
}

/** The state directory: this host's expeditor log lives here. */
export function kitchenStateDir(env: Env): string {
  return path.join(userStateRoot(env), "kitchen");
}

/** The structured log of this host's expeditor: one JSON object per line. */
export function expeditorLogFile(env: Env): string {
  return path.join(kitchenStateDir(env), "expeditor.jsonl");
}

/** The host config `kitchen init` wrote, or undefined when this host has none yet. */
export function readHostConfig(env: Env): HostConfig | undefined {
  const file = hostConfigFile(env);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as HostConfig;
}

export function writeHostConfig(env: Env, config: HostConfig): string {
  const file = hostConfigFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}
