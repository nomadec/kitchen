// kitchen down: stop this host's expeditor cleanly and remove its service unit. The claims the
// expeditor's turns hold are left as they are: their leases go stale and a later tick reclaims them.
import fs from "node:fs";
import type { Command } from "../cli.ts";
import { runEach, unitFor } from "./service-unit.ts";

const USAGE = `Usage: kitchen down

Stops this host's expeditor and removes its user service, leaving claimed phases reclaimable.
`;

export const down: Command = async (args, deps) => {
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  if (args.length) {
    deps.stderr(`kitchen down: takes no arguments\n\n${USAGE}`);
    return 1;
  }
  const unit = unitFor(deps);
  if ("error" in unit) {
    deps.stderr(`kitchen down: ${unit.error}\n`);
    return 1;
  }
  if (!fs.existsSync(unit.file)) {
    deps.stderr(`kitchen down: no expeditor service at ${unit.file}: nothing to stop\n`);
    return 1;
  }
  if (!(await runEach(deps, "down", unit.stop))) return 1;
  fs.rmSync(unit.file);
  if (!(await runEach(deps, "down", unit.forget))) return 1;
  deps.stdout(`Stopped the expeditor and removed ${unit.file}\n`);
  return 0;
};
