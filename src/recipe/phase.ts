// A phase file: frontmatter with Umka's keys plus Kitchen's, then the markdown body. The parsed
// shape is what registration lints and what intake, the expeditor and the graph read back from a
// phase bead's description.

/** Umka's keys and Kitchen's, the only ones a phase file may carry (spec: Store). */
export const PHASE_KEYS: readonly string[] = [
  "phase", "skill", "from", "to", "artifact", "ask",
  "model", "needs", "rounds", "entry", "budget", "skip when",
];

/** One `to` entry: the target phase, the prose rule under which it is laid, the item it fans out per. */
export interface Edge {
  phase: string;
  when?: string;
  per?: string;
}

/** A dollar cap and an effort, never a token count. */
export interface Budget {
  usd: number;
  effort: string;
}

export interface Phase {
  /** The file name without `.md`; the `phase` key must agree with it. */
  slug: string;
  file: string;
  /** The whole file: the description of the phase bead. */
  text: string;
  /** The markdown after the frontmatter. */
  body: string;
  phase: string;
  /** `human` on a pass phase. */
  skill: string;
  from: string[];
  to: Edge[];
  artifact: string;
  ask?: string;
  model?: string;
  /** Prose the laying turn reads to choose a station. */
  needs?: string;
  rounds?: number;
  /** The classes this phase is the entry for. */
  entry: string[];
  budget?: Budget;
  /** On a pass phase: the prose rule under which the laying turn skips the pass. */
  skipWhen?: string;
}

/** A pass phase (spec: Store) is one with `skill: human`: never worked, it lays a pass. */
export const isPass = (phase: Pick<Phase, "skill">): boolean => phase.skill === "human";

/** The slug of a phase file: its name without the directory and `.md`. */
export const slugOf = (file: string): string => file.replace(/^.*\//, "").replace(/\.md$/, "");

/** The title of a registered phase bead, `<recipe>/<slug>`. */
export const phaseTitle = (recipe: string, slug: string): string => `${recipe}/${slug}`;

/** Reads a phase bead's title back; undefined when it is not `<recipe>/<slug>`. */
export function splitTitle(title: string): { recipe: string; slug: string } | undefined {
  const slash = title.indexOf("/");
  if (slash <= 0 || slash === title.length - 1) return undefined;
  return { recipe: title.slice(0, slash), slug: title.slice(slash + 1) };
}

/** A phase file that does not have the shape: the file, the key or rule, and what is wrong. */
export class PhaseError extends Error {
  readonly file: string;
  readonly rule: string;
  constructor(file: string, rule: string, message: string) {
    super(`${file}: ${rule}: ${message}`);
    this.name = "PhaseError";
    this.file = file;
    this.rule = rule;
  }
}

type Mapping = Record<string, string>;
/** A frontmatter value as the YAML subset gives it: a line, a flow list, a nested mapping, or a block list. */
type FrontmatterValue = string | string[] | Mapping | Array<string | Mapping>;

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Parses a phase file into its shape. Throws PhaseError at the first key that is malformed. */
export function parsePhaseFile(text: string, file: string): Phase {
  const slug = slugOf(file);
  const fail = (rule: string, message: string): never => {
    throw new PhaseError(file, rule, message);
  };
  const match = FRONTMATTER.exec(text);
  if (!match || match[1] === undefined) return fail("frontmatter", "no frontmatter block");
  const raw = parseFrontmatter(match[1], (message) => fail("frontmatter", message));
  const body = text.slice(match[0].length);

  for (const key of Object.keys(raw)) {
    if (!PHASE_KEYS.includes(key)) {
      const gone = key === "mode" ? " (gone in Kitchen: presence is a need, a pass is a phase with skill: human)"
        : key === "auto-close when" ? " (gone in Kitchen: a pass phase carries skip when)" : "";
      fail(key, `unknown key${gone}`);
    }
  }

  const scalar = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value === "") return fail(key, "must be one line of text");
    return value;
  };
  const required = (key: string): string => scalar(key) ?? fail(key, "missing");
  const names = (key: string): string[] => {
    const value = raw[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) fail(key, "must be a list of phase names, [a, b]");
    return value as string[];
  };

  const phase = required("phase");
  if (phase !== slug) fail("phase", `"${phase}" differs from the file name "${slug}"`);
  const skill = required("skill");
  if (raw.from === undefined) fail("from", "missing: [] on a phase nothing leads to");
  const from = names("from");
  if (raw.to === undefined) return fail("to", "missing: [] on a phase nothing follows");
  const to = edges(raw.to, fail);
  const artifact = required("artifact");
  const entry = names("entry");

  const shape: Phase = { slug, file, text, body, phase, skill, from, to, artifact, entry };
  const ask = scalar("ask");
  if (ask !== undefined) shape.ask = ask;
  const model = scalar("model");
  if (model !== undefined) {
    if (/\s/.test(model)) fail("model", `"${model}" is not one model name`);
    shape.model = model;
  }
  const needs = scalar("needs");
  if (needs !== undefined) shape.needs = needs;
  const rounds = scalar("rounds");
  if (rounds !== undefined) {
    if (!/^[1-9]\d*$/.test(rounds)) fail("rounds", `"${rounds}" is not a positive whole number`);
    shape.rounds = Number(rounds);
  }
  if (raw.budget !== undefined) shape.budget = budget(raw.budget, fail);
  const skipWhen = scalar("skip when");
  if (skipWhen !== undefined) shape.skipWhen = skipWhen;

  if (isPass(shape)) {
    if (shape.ask === undefined) fail("ask", "missing on a pass phase (skill: human): what the brief lists");
  } else {
    if (shape.skipWhen !== undefined) fail("skip when", "only a pass phase (skill: human) has one");
    if (shape.model === undefined) fail("model", "missing: the model this phase runs on");
    if (shape.budget === undefined) fail("budget", "missing: an object with usd and effort");
  }
  return shape;
}

function edges(value: FrontmatterValue, fail: (rule: string, message: string) => never): Edge[] {
  if (!Array.isArray(value)) return fail("to", "must be a list of entries, each `- phase: <name>`");
  return value.map((item) => {
    if (typeof item === "string") return { phase: item };
    const { phase, when, per, ...rest } = item;
    if (!phase) return fail("to", "an entry has no phase");
    const extra = Object.keys(rest);
    if (extra.length) return fail("to", `entry ${phase} has a key that is not when or per: ${extra.join(", ")}`);
    const edge: Edge = { phase };
    if (when !== undefined) edge.when = when;
    if (per !== undefined) edge.per = per;
    return edge;
  });
}

function budget(value: FrontmatterValue, fail: (rule: string, message: string) => never): Budget {
  if (typeof value === "string") {
    const count = /^\d+k?$/i.test(value) ? "a token count or a bare number" : "a scalar";
    return fail("budget", `"${value}" is ${count}; budget is an object with usd (a dollar cap) and effort`);
  }
  if (Array.isArray(value)) return fail("budget", "is a list; budget is an object with usd (a dollar cap) and effort");
  const { usd, effort, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length) return fail("budget", `has a key that is not usd or effort: ${extra.join(", ")}`);
  if (usd === undefined || !/^\d+(\.\d+)?$/.test(usd) || Number(usd) <= 0) {
    return fail("budget", `usd "${usd ?? ""}" is not a dollar amount above zero`);
  }
  if (!effort || /\s/.test(effort)) return fail("budget", `effort "${effort ?? ""}" is not one word`);
  return { usd: Number(usd), effort };
}

// The YAML subset the frontmatter uses: `key: scalar`, `key: [a, b]`, `key: []`, `key:` followed
// by a block list (`  - name` or `  - k: v` with `    k: v` continuations), or by a nested
// mapping (`  k: v` lines). A bare `key:` with no block is an empty list.
export function parseFrontmatter(block: string, fail: (message: string) => never): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  let openKey: string | undefined;
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const item = /^ {2}- (.*)$/.exec(line);
    const nested = /^ {2,}([^:\s][^:]*):(.*)$/.exec(line);
    if (openKey !== undefined && item && item[1] !== undefined) {
      const list = data[openKey];
      if (!Array.isArray(list)) return fail(`cannot read line "${line}"`);
      const kv = /^([^:]+): (.*)$/.exec(item[1]);
      (list as Array<string | Mapping>).push(kv ? { [kv[1]!.trim()]: kv[2]!.trim() } : item[1].trim());
      continue;
    }
    if (openKey !== undefined && nested && nested[1] !== undefined) {
      const key = nested[1].trim();
      const value = (nested[2] ?? "").trim();
      const current = data[openKey];
      if (Array.isArray(current) && current.length === 0) {
        data[openKey] = { [key]: value };
      } else if (Array.isArray(current)) {
        const last = current[current.length - 1];
        if (typeof last !== "object") return fail(`cannot read line "${line}"`);
        last[key] = value;
      } else if (typeof current === "object") {
        current[key] = value;
      } else {
        return fail(`cannot read line "${line}"`);
      }
      continue;
    }
    const kv = /^([^\s:][^:]*):(.*)$/.exec(line);
    if (!kv || kv[1] === undefined) return fail(`cannot read line "${line}"`);
    const key = kv[1].trim();
    const value = (kv[2] ?? "").trim();
    if (value === "") {
      // The block that follows decides: a list, a mapping, or nothing.
      data[key] = [];
      openKey = key;
      continue;
    }
    openKey = undefined;
    const flow = /^\[(.*)\]$/.exec(value);
    data[key] = flow ? flow[1]!.split(",").map((s) => s.trim()).filter(Boolean) : value;
  }
  return data;
}
