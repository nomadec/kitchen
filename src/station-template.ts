// The station template as a plugin directory or a file holds it: the one reader of the station that
// touches the file system, kept apart from station.ts so the browser can import the rest.
import fs from "node:fs";
import path from "node:path";
import { parseJson, shape, StationError } from "./station.ts";
import type { StationTemplate } from "./station.ts";

/** The file a plugin directory holds its station template in. */
export const TEMPLATE_FILE = "station.json";

/** Reads a template from a file, or from a plugin directory holding `station.json`. */
export function loadTemplate(target: string): StationTemplate {
  const file = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, TEMPLATE_FILE) : target;
  if (!fs.existsSync(file)) throw new StationError(`no station template at ${file}`);
  const fields = shape(parseJson(fs.readFileSync(file, "utf8"), file), file);
  const template: StationTemplate = {
    offers: fields.text("offers"),
    provider: fields.text("provider"),
    models: fields.list("models"),
    auth: fields.text("auth"),
    plugins: fields.list("plugins"),
    skills: fields.list("skills"),
    repositories: fields.list("repositories"),
    worktrees: fields.text("worktrees"),
    budget: fields.budget(),
  };
  const name = fields.raw.name;
  if (typeof name === "string" && name !== "") template.name = name;
  return template;
}
