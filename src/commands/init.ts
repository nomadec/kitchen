// kitchen init: write the host config and set the space up in one step. With --server the space is a
// database on a Dolt SQL server, shared by every host that points at it; with --local it is an
// embedded beads workspace on this host alone, with nothing to install and nothing to connect to.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../cli.ts";
import { spaceDir, userConfigRoot, writeHostConfig } from "../config.ts";
import type { HostConfig, SpaceServer } from "../config.ts";
import { REGISTERED_TYPES } from "../space.ts";

const USAGE = `Usage: kitchen init (--server <host:port> | --local) --owner <name> [options]

Options:
  --server <host:port>   The Dolt SQL server the space lives on: one space shared by every host
  --local                A space of this host's own: an embedded beads workspace, no server
  --owner <name>         The person this host belongs to; the human actor (required)
  --host <name>          This host's name as stations will carry it (default: the hostname)

With --server:
  --database <name>      The space's database on that server (default: kitchen)
  --user <name>          The SQL user; one per person (default: the owner)
  --credential <file>    The beads credentials file holding the [host:port] password
                         (default: ~/.config/beads/credentials)
`;

/** What every space is configured with: Kitchen's bead types and the events journal the UI reads. */
export const SPACE_CONFIG: readonly (readonly [string, string])[] = [
  ["types.custom", REGISTERED_TYPES.join(",")],
  ["events-journal", "true"],
];

export const init: Command = async (args, deps) => {
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  const parsed = parseOptions(args, deps.hostname, path.join(userConfigRoot(deps.env), "beads", "credentials"));
  if ("error" in parsed) {
    deps.stderr(`kitchen init: ${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const config = parsed.config;
  const { server } = config;

  // bd 1.3.1 reads the credentials file for every command after init, but bd init itself takes the
  // server password from BEADS_DOLT_PASSWORD only: the init call carries the section's password in
  // its environment and nothing else does. A file or section that is missing is refused here.
  let password: string | undefined;
  if (server && config.credential !== undefined) {
    const read = credentialPassword(config.credential, `${server.host}:${server.port}`);
    if ("error" in read) {
      deps.stderr(`kitchen init: ${read.error}\n`);
      return 1;
    }
    password = read.password;
  }

  // The beads workspace every later bd command runs from. An existing one is re-initialised in place
  // (local metadata only; a server's data is untouched) and is never removed by a failed run.
  const space = spaceDir(deps.env);
  const spaceExisted = fs.existsSync(space);
  fs.mkdirSync(space, { recursive: true });
  const env: Record<string, string> = {
    ...(config.credential === undefined ? {} : { BEADS_CREDENTIALS_FILE: config.credential }),
    ...(password === undefined ? {} : { BEADS_DOLT_PASSWORD: password }),
  };
  const verification = await deps.runner(
    [
      "bd", "--actor", config.owner, "init",
      ...(server
        ? ["--server", "--external", "--server-host", server.host, "--server-port", String(server.port), "--server-user", server.user, "--database", server.database]
        : []),
      "--prefix", "kitchen",
      "--non-interactive", "--quiet", "--skip-agents", "--skip-hooks",
      ...(spaceExisted ? ["--reinit-local"] : []),
    ],
    { cwd: space, env },
  );
  if (verification.exitCode !== 0) {
    if (!spaceExisted) fs.rmSync(space, { recursive: true, force: true });
    deps.stderr(server
      ? `kitchen init: could not reach the space at ${server.host}:${server.port} as ${server.user}\n${verification.stderr}`
      : `kitchen init: could not create the local space at ${space}\n${verification.stderr}`);
    return 1;
  }

  // What the space needs from beads: Kitchen's bead types and the journal. Set again on every init
  // to the same values, so a space the server installer configured is unchanged and a new one is ready.
  for (const [key, value] of SPACE_CONFIG) {
    const set = await deps.runner(["bd", "--actor", config.owner, "config", "set", key, value], { cwd: space, env });
    if (set.exitCode !== 0) {
      deps.stderr(`kitchen init: bd config set ${key} failed\n${set.stderr}`);
      return 1;
    }
  }

  const file = writeHostConfig(deps.env, config);
  deps.stdout(server
    ? `Connected to ${server.host}:${server.port} as ${server.user}. Config written to ${file}\n`
    : `Local space created at ${space}. Config written to ${file}\n`);
  return 0;
};

function parseOptions(
  args: readonly string[],
  hostname: string,
  defaultCredential: string,
): { config: HostConfig } | { error: string } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        server: { type: "string" },
        local: { type: "boolean" },
        owner: { type: "string" },
        database: { type: "string" },
        user: { type: "string" },
        credential: { type: "string" },
        host: { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const owner = typeof values.owner === "string" ? values.owner : undefined;
  const host = typeof values.host === "string" ? values.host : hostname;
  if (!owner) return { error: "--owner <name> is required" };
  if (values.local) {
    const serverOnly = ["server", "database", "user", "credential"].filter((name) => values[name] !== undefined);
    if (serverOnly.length) return { error: `--local takes no ${serverOnly.map((name) => `--${name}`).join(", ")}: a local space has no server` };
    return { config: { owner, host } };
  }
  if (typeof values.server !== "string") return { error: "--server <host:port> or --local is required" };
  const address = parseAddress(values.server);
  if (!address) return { error: `--server must be host:port, got ${values.server}` };

  const server: SpaceServer = {
    ...address,
    user: typeof values.user === "string" ? values.user : owner,
    database: typeof values.database === "string" ? values.database : "kitchen",
  };
  return {
    config: {
      server,
      credential: typeof values.credential === "string" ? values.credential : defaultCredential,
      owner,
      host,
    },
  };
}

/**
 * The password of the `[host:port]` section of a beads credentials file: INI lines, `password=` or
 * `password = `, `#` comments. bd's own format (docs/architecture/dolt.md in beads).
 */
function credentialPassword(file: string, section: string): { password: string } | { error: string } {
  if (!fs.existsSync(file)) return { error: `no credentials file at ${file}: put the password of [${section}] there (docs/onboarding.md)` };
  let current: string | undefined;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    const entry = /^password\s*=\s*(.*)$/.exec(line);
    if (current === section && entry && entry[1] !== undefined) return { password: entry[1].trim() };
  }
  return { error: `${file} has no [${section}] section with a password: bd reads the server's password from it` };
}

function parseAddress(text: string): { host: string; port: number } | undefined {
  const match = /^(.+):(\d+)$/.exec(text);
  if (!match || !match[1] || !match[2]) return undefined;
  return { host: match[1], port: Number(match[2]) };
}
