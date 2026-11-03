// `bd serve` as the expeditor runs it (spec: Expeditor, story 69): bound to loopback on a fixed port,
// behind a token file the expeditor generates and owns, mode 0600, so the UI it serves beside it talks
// to the space with a bearer token and never holds the SQL credential. The token is one line, as
// bd serve reads it; the file is written whole and renamed into place, as bd serve asks.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { serveTokenFile } from "../config.ts";
import type { HostConfig } from "../config.ts";
import type { CommandResult, CommandRunner } from "../runner.ts";
import { spaceConnection } from "../space.ts";

/** The loopback address every bd serve of Kitchen binds. */
export const LOOPBACK = "127.0.0.1";

export interface ServeDeps {
  runner: CommandRunner;
  env: Record<string, string | undefined>;
  config: HostConfig;
}

export interface Serve {
  /** Where bd serve answers: `http://127.0.0.1:<port>`. */
  url: string;
  tokenFile: string;
  /** The command's result, once it has exited: on stop, or earlier when it could not serve. */
  done: Promise<CommandResult>;
  stop(): void;
}

/** Writes a fresh token and starts bd serve on the port, over the space connection every bd call uses. */
export function startServe(deps: ServeDeps, port: number): Serve {
  const tokenFile = serveTokenFile(deps.env);
  writeToken(tokenFile);
  const controller = new AbortController();
  const argv = ["bd", "serve", "--addr", `${LOOPBACK}:${port}`, "--auth-token-file", tokenFile];
  const done = deps.runner(argv, { ...spaceConnection(deps.env, deps.config), signal: controller.signal });
  return { url: `http://${LOOPBACK}:${port}`, tokenFile, done, stop: () => controller.abort() };
}

function writeToken(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, `${token}\n`, { mode: 0o600 });
  fs.renameSync(staging, file);
}
