// The station: a prepared place (ADR 0005) registered as a bead of type `station`. A template, from a
// plugin or a file, gives the shape; the values only the host knows complete it. Both directions live
// here: the bead a template and values become, and the station read back from a bead.
import fs from "node:fs";
import path from "node:path";
import { labelValue, noteLine } from "./fields.ts";
import type { Bead, CreateFields } from "./space.ts";

/** The file a plugin directory holds its station template in. */
export const TEMPLATE_FILE = "station.json";

/** The shape a template gives: everything in the launch spec that is not about one host. */
export interface StationTemplate {
  /** The default station name; `--name` overrides it. */
  name?: string;
  /** What the station offers, in prose, for the laying turn to read. */
  offers: string;
  provider: string;
  models: string[];
  /** How the provider signs in, as the runner understands it: `subscription` for the claude CLI. */
  auth: string;
  plugins: string[];
  skills: string[];
  /** The repositories the station offers, by remote slug; the host gives each a local path. */
  repositories: string[];
  /** The worktree policy: `per-order` is the one v1 runners implement. */
  worktrees: string;
  /** The budget per turn. */
  budget: Budget;
}

export interface Budget {
  usd: number;
  effort: string;
}

/** The part of a station that says how to start a turn. Provider-neutral in shape; secrets are names only. */
export interface LaunchSpec {
  provider: string;
  models: string[];
  auth: string;
  plugins: string[];
  skills: string[];
  repositories: { slug: string; path: string }[];
  worktrees: string;
  cap: number;
  budget: Budget;
  /** The wall-clock timeout of one turn, as a duration such as `45m`. */
  timeout: string;
  secrets: string[];
}

/** What a phase and its order need of a station mechanically: the model, and every repository checked out. */
export interface Need {
  model: string | undefined;
  repos: readonly string[];
}

/** What the station lacks of the need: the model, each repository; empty when it qualifies (ADR 0002's one mechanical check). */
export function lacks(station: Pick<Station, "launch">, need: Need): string[] {
  const offered = station.launch.repositories.map((r) => r.slug);
  return [
    ...(need.model !== undefined && station.launch.models.includes(need.model) ? [] : [`model ${need.model ?? "(none)"}`]),
    ...need.repos.filter((slug) => !offered.includes(slug)),
  ];
}

/** The station's checkouts of the repositories an order names, in the order it names them; one it does not offer is left out. */
export function offeredCheckouts(launch: LaunchSpec, repos: readonly string[]): { slug: string; path: string }[] {
  return repos.flatMap((slug) => launch.repositories.filter((r) => r.slug === slug));
}

/** The values only the registering host knows. */
export interface StationValues {
  owner: string;
  host: string;
  name?: string;
  offers?: string;
  /** Local path per repository slug the template lists. */
  paths: Record<string, string>;
  cap?: number;
  timeout?: string;
  secrets: string[];
  attended: boolean;
}

export interface Station {
  id: string;
  /** `<owner>/<name>`: the station title, the assignee of a phase laid for it and its turn actor. */
  title: string;
  owner: string;
  name: string;
  host: string;
  cap: number;
  attended: boolean;
  offers: string;
  launch: LaunchSpec;
}

/** A template, a set of values or a bead that cannot be a station; the message names what is missing. */
export class StationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StationError";
  }
}

const TIMEOUT = /^\d+(s|m|h)$/;

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

/** The `bd create` fields of the station bead a template and the host's values make. */
export function stationFields(template: StationTemplate, values: StationValues): CreateFields {
  const name = values.name ?? template.name;
  if (!name) throw new StationError("--name <name> is required: the template gives no name");
  if (values.cap === undefined) throw new StationError("--cap <n> is required");
  if (!Number.isInteger(values.cap) || values.cap < 1) throw new StationError(`--cap must be a whole number of turns, got ${values.cap}`);
  if (!values.timeout) throw new StationError("--timeout <duration> is required");
  if (!TIMEOUT.test(values.timeout)) throw new StationError(`--timeout must be a duration such as 45m, got ${values.timeout}`);
  const repositories = template.repositories.map((slug) => {
    const local = values.paths[slug];
    if (!local) throw new StationError(`--repo ${slug}=<local path> is required: the template offers ${slug}`);
    return { slug, path: local };
  });
  for (const slug of Object.keys(values.paths)) {
    if (!template.repositories.includes(slug)) throw new StationError(`--repo ${slug}: the template does not offer ${slug}`);
  }
  const launch: LaunchSpec = {
    provider: template.provider,
    models: template.models,
    auth: template.auth,
    plugins: template.plugins,
    skills: template.skills,
    repositories,
    worktrees: template.worktrees,
    cap: values.cap,
    budget: template.budget,
    timeout: values.timeout,
    secrets: values.secrets,
  };
  return {
    title: `${values.owner}/${name}`,
    type: "station",
    labels: [`owner:${values.owner}`, `host:${values.host}`, `cap:${values.cap}`, ...(values.attended ? ["attended"] : [])],
    notes: `offers: ${values.offers ?? template.offers}\n\n\`\`\`json\n${JSON.stringify(launch, null, 2)}\n\`\`\``,
  };
}

const FENCE = /```json\n([\s\S]*?)\n```/;

/** The station a bead holds, as `bd show` or `bd list` printed it. */
export function parseStation(bead: Bead): Station {
  if (bead.issue_type !== "station") throw new StationError(`${bead.id} is a ${bead.issue_type} bead, not a station`);
  const label = (key: string): string => {
    const value = labelValue(bead, key);
    if (value === undefined) throw new StationError(`${bead.id} carries no ${key}: label`);
    return value;
  };
  const owner = label("owner");
  if (!bead.title.startsWith(`${owner}/`) || bead.title.length === owner.length + 1) {
    throw new StationError(`${bead.id} is titled ${bead.title}, not ${owner}/<name>`);
  }
  const cap = Number(label("cap"));
  if (!Number.isInteger(cap) || cap < 1) throw new StationError(`${bead.id} carries cap:${label("cap")}, not a whole number of turns`);
  const notes = bead.notes ?? "";
  const offers = noteLine(notes, "offers");
  if (offers === undefined) throw new StationError(`${bead.id} carries no offers: line`);
  const block = FENCE.exec(notes)?.[1];
  if (block === undefined) throw new StationError(`${bead.id} carries no launch spec`);
  return {
    id: bead.id,
    title: bead.title,
    owner,
    name: bead.title.slice(owner.length + 1),
    host: label("host"),
    cap,
    attended: (bead.labels ?? []).includes("attended"),
    offers,
    launch: parseLaunch(block, `${bead.id}'s launch spec`),
  };
}

function parseLaunch(block: string, where: string): LaunchSpec {
  const fields = shape(parseJson(block, where), where);
  const repositories = fields.raw.repositories;
  if (!Array.isArray(repositories) || !repositories.every(isRepository)) throw new StationError(`${where} lacks repositories (a list of slug and path)`);
  const cap = fields.raw.cap;
  if (typeof cap !== "number") throw new StationError(`${where} lacks cap`);
  return {
    provider: fields.text("provider"),
    models: fields.list("models"),
    auth: fields.text("auth"),
    plugins: fields.list("plugins"),
    skills: fields.list("skills"),
    repositories,
    worktrees: fields.text("worktrees"),
    cap,
    budget: fields.budget(),
    timeout: fields.text("timeout"),
    secrets: fields.list("secrets"),
  };
}

function isRepository(value: unknown): value is { slug: string; path: string } {
  const r = value as Record<string, unknown> | null;
  return typeof r === "object" && r !== null && typeof r.slug === "string" && typeof r.path === "string";
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StationError(`${where} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The typed readers of one JSON object's fields; each names the field it lacks. */
function shape(value: unknown, where: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StationError(`${where} must hold a JSON object`);
  const raw = value as Record<string, unknown>;
  const lacks = (what: string) => new StationError(`${where} lacks ${what}`);
  return {
    raw,
    text(key: string): string {
      const v = raw[key];
      if (typeof v !== "string" || v === "") throw lacks(key);
      return v;
    },
    list(key: string): string[] {
      const v = raw[key];
      if (!Array.isArray(v) || !v.every((item) => typeof item === "string")) throw lacks(`${key} (a list of strings)`);
      return v;
    },
    budget(): Budget {
      const b = raw.budget as Record<string, unknown> | undefined;
      if (typeof b?.usd !== "number" || typeof b.effort !== "string") throw lacks("budget with usd and effort");
      return { usd: b.usd, effort: b.effort };
    },
  };
}
