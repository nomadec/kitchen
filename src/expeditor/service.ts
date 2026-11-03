// The expeditor as a user service (ADR 0003): a systemd user unit on Linux, a launchd agent on macOS.
// `kitchen up` writes the unit for the current platform and starts it; `kitchen down` stops it and
// removes the unit. The unit runs `kitchen up --foreground`, the long-lived process itself.
import path from "node:path";
import type { Program } from "../cli.ts";
import { kitchenStateDir, userConfigRoot } from "../config.ts";

export const SERVICE_NAME = "kitchen-expeditor";
const LAUNCHD_LABEL = "ai.nomadec.kitchen.expeditor";

/** Seconds between ticks when `kitchen up` is given no interval. */
export const DEFAULT_INTERVAL = 5;

/** The environment entries the service carries over from the shell `kitchen up` ran in. */
const CARRIED_ENV = ["PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;

export interface ServiceSpec {
  program: Program;
  host: string;
  env: Record<string, string | undefined>;
  /** Seconds between ticks; the default when the caller only needs the unit's file and stop commands. */
  interval?: number;
}

export interface ServiceUnit {
  /** Where the unit lives. */
  file: string;
  content: string;
  /** The commands that start it once the file is written, in order. */
  install: string[][];
  /** The commands that stop it, before the file is removed. */
  stop: string[][];
  /** The commands that run after the file is removed. */
  forget: string[][];
}

/** A platform `kitchen up` has no service manager for. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export function serviceUnit(spec: ServiceSpec): ServiceUnit {
  const command = [...spec.program.argv, "up", "--foreground", "--interval", String(spec.interval ?? DEFAULT_INTERVAL)];
  const environment = CARRIED_ENV.flatMap((name) => {
    const value = spec.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  switch (spec.program.platform) {
    case "linux":
      return systemdUnit(spec, command, environment);
    case "darwin":
      return launchdAgent(spec, command, environment);
    default:
      throw new ServiceError(`no user service manager for ${spec.program.platform}: kitchen up supports linux (systemd) and darwin (launchd)`);
  }
}

type Environment = readonly (readonly [string, string])[];

function systemdUnit(spec: ServiceSpec, command: string[], environment: Environment): ServiceUnit {
  const unit = `${SERVICE_NAME}.service`;
  const content = [
    "[Unit]",
    `Description=Kitchen expeditor on ${spec.host}`,
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${command.map(systemdQuote).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    ...environment.map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    file: path.join(userConfigRoot(spec.env), "systemd", "user", unit),
    content,
    install: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", unit]],
    stop: [["systemctl", "--user", "disable", "--now", unit]],
    forget: [["systemctl", "--user", "daemon-reload"]],
  };
}

function launchdAgent(spec: ServiceSpec, command: string[], environment: Environment): ServiceUnit {
  const file = path.join(spec.env.HOME ?? "", "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const stateDir = kitchenStateDir(spec.env);
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${LAUNCHD_LABEL}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    ...command.map((arg) => `      <string>${xml(arg)}</string>`),
    "    </array>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    ...environment.map(([name, value]) => `      <key>${name}</key>\n      <string>${xml(value)}</string>`),
    "    </dict>",
    "    <key>StandardOutPath</key>",
    `    <string>${xml(path.join(stateDir, "expeditor.stdout.log"))}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${xml(path.join(stateDir, "expeditor.stderr.log"))}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
  return {
    file,
    content,
    install: [["launchctl", "load", "-w", file]],
    stop: [["launchctl", "unload", "-w", file]],
    forget: [],
  };
}

/** systemd splits ExecStart and Environment on whitespace; a value holding any is quoted. */
function systemdQuote(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
