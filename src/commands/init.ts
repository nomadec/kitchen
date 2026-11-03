// kitchen init: write the host config and verify the connection to the space in one step.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../cli.ts";
import { spaceDir, userConfigRoot, writeHostConfig } from "../config.ts";
import type { HostConfig, SpaceServer } from "../config.ts";

const USAGE = `Usage: kitchen init --server <host:port> --owner <name> [options]

Options:
  --server <host:port>   The Dolt SQL server the space lives on (required)
  --owner <name>         The person this host belongs to; the human actor (required)
  --database <name>      The space's database on that server (default: kitchen)
  --user <name>          The SQL user; one per person (default: the owner)
  --credential <file>    The beads credentials file holding the [host:port] password
                         (default: ~/.config/beads/credentials)
  --host <name>          This host's name as stations will carry it (default: the hostname)
`;

export const init: Command = async (args, deps) => {
  const parsed = parseOptions(args, deps.hostname, path.join(userConfigRoot(deps.env), "beads", "credentials"));
  if ("error" in parsed) {
    deps.stderr(`kitchen init: ${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const config = parsed.config;
  const { server } = config;

  // The beads workspace every later bd command runs from. An existing one is re-initialised in place
  // (local metadata only; the server's data is untouched) and is never removed by a failed run.
  const space = spaceDir(deps.env);
  const spaceExisted = fs.existsSync(space);
  fs.mkdirSync(space, { recursive: true });
  const verification = await deps.runner(
    [
      "bd", "--actor", config.owner, "init",
      "--server", "--external",
      "--server-host", server.host, "--server-port", String(server.port), "--server-user", server.user,
      "--database", server.database, "--prefix", "kitchen",
      "--non-interactive", "--quiet",
      ...(spaceExisted ? ["--reinit-local"] : []),
    ],
    { cwd: space, env: { BEADS_CREDENTIALS_FILE: config.credential } },
  );
  if (verification.exitCode !== 0) {
    if (!spaceExisted) fs.rmSync(space, { recursive: true, force: true });
    deps.stderr(`kitchen init: could not reach the space at ${server.host}:${server.port} as ${server.user}\n${verification.stderr}`);
    return 1;
  }

  const file = writeHostConfig(deps.env, config);
  deps.stdout(`Connected to ${server.host}:${server.port} as ${server.user}. Config written to ${file}\n`);
  return 0;
};

function parseOptions(
  args: readonly string[],
  hostname: string,
  defaultCredential: string,
): { config: HostConfig } | { error: string } {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        server: { type: "string" },
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
  if (!values.server) return { error: "--server <host:port> is required" };
  if (!values.owner) return { error: "--owner <name> is required" };
  const address = parseAddress(values.server);
  if (!address) return { error: `--server must be host:port, got ${values.server}` };

  const server: SpaceServer = {
    ...address,
    user: values.user ?? values.owner,
    database: values.database ?? "kitchen",
  };
  return {
    config: {
      server,
      credential: values.credential ?? defaultCredential,
      owner: values.owner,
      host: values.host ?? hostname,
    },
  };
}

function parseAddress(text: string): { host: string; port: number } | undefined {
  const match = /^(.+):(\d+)$/.exec(text);
  if (!match || !match[1] || !match[2]) return undefined;
  return { host: match[1], port: Number(match[2]) };
}
