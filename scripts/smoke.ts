#!/usr/bin/env node
// The hand-run smoke (spec story 81), run before a release against a real bd and a real claude:
//
//     node scripts/smoke.ts --server 127.0.0.1:3307 --user root --credential ~/.config/beads/credentials
//
// It creates a separate database on the server through kitchen init, registers a recipe from the
// plugin directory given (--plugin; the fixture under scripts/smoke-fixture by default, the migrated
// Umka plugin once it has its phase directory), registers one unattended station on this host, adds
// one synthetic order, runs the expeditor tick by tick (kitchen up --foreground --once) within a bound,
// and asserts the three outcomes the spec names: the order reaches its first pass with a brief, laid and
// assigned by a turn; the pass closes only when answered under the human actor (kitchen pass); the
// phase behind the pass runs and applies the answer once. Then it prints the bead ids it created and
// one run-record row per check, PASS, FAIL or BLOCKED, for docs/qa/issue-1-spec-review.md.
//
// This is the one script that runs outside the command-runner seam, on purpose: it is the integration
// evidence for the real processes, so it spawns the kitchen command, bd and (through the expeditor)
// claude itself and reads the host's clock for its bound. Every write to the space goes through a
// kitchen command, or through bd under the owner's actor for the two config keys the server install
// script sets for the team space; the reads are bd --json over the space kitchen init wrote, and the
// expeditor's log. Not a CLI command, and not a unit test: the fixture it ships is tested in
// scripts/smoke.test.ts, the smoke itself is the evidence.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { KITCHEN_LAID } from "../src/expeditor/answers.ts";
import type { Bead as KitchenBead } from "../src/space.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const KITCHEN = path.join(ROOT, "dist", "bin", "kitchen.js");
const FIXTURE = path.join(ROOT, "scripts", "smoke-fixture");

const USAGE = `Usage: node scripts/smoke.ts --server <host:port> --user <sql user> --credential <file> [options]

Options:
  --server <host:port>    The Dolt SQL server to create the smoke's database on (required)
  --user <name>           The SQL user; it must be allowed to create a database (required)
  --credential <file>     The beads credentials file holding the [host:port] password (required)
  --owner <name>          The human actor of the run (default: smoke)
  --plugin <dir>          The plugin directory to register the recipe from (default: scripts/smoke-fixture)
  --station <file>        The station template (default: <plugin>/station.json, else the fixture's)
  --class <class>         The class the order enters with; the recipe needs an entry phase for it (default: idea)
  --word <word>           The human's answer on the pass (default: go)
  --minutes <n>           The bound on the expeditor's run, in minutes (default: 20)
  --dir <path>            Where the run's config, state and log go (default: a fresh directory under the temp dir)
`;

type Result = "PASS" | "FAIL" | "BLOCKED";

interface Check {
  name: string;
  result: Result;
  evidence: string;
}

/** A check that cannot run on this host for a reason outside Kitchen: recorded BLOCKED, not FAIL. */
class Blocked extends Error {}

/** A bead as bd --json prints it, with the fields beyond Kitchen's own that the checks read. */
interface Bead extends KitchenBead {
  labels?: string[];
  assignee?: string | null;
  created_by?: string;
  closed_by?: string;
  close_reason?: string;
  parent?: string | null;
  dependencies?: Array<{ id: string; dependency_type?: string }> | null;
}

/** The `turn` line of the expeditor log: how one turn ended. */
interface TurnLine {
  phase: string;
  exit?: number;
  result?: string;
  outcome?: string;
  failure?: string;
}

/** What a spawned command answered. */
interface Exit {
  status: number;
  stdout: string;
  stderr: string;
}

/** The beads the smoke created, filled in as the checks go; a later check needs what an earlier one made. */
interface Created {
  recipe?: string;
  revision?: string;
  phases?: string[];
  station?: string;
  stationBead?: string;
  order?: string;
  entry?: string;
  pass?: string;
  behind?: string;
}

const values = parseArgs({
  args: process.argv.slice(2),
  options: {
    server: { type: "string" }, user: { type: "string" }, credential: { type: "string" },
    owner: { type: "string", default: "smoke" }, plugin: { type: "string", default: FIXTURE },
    station: { type: "string" }, class: { type: "string", default: "idea" }, word: { type: "string", default: "go" },
    minutes: { type: "string", default: "20" }, dir: { type: "string" }, help: { type: "boolean" },
  },
  strict: true,
}).values;

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!values.server || !values.user || !values.credential) {
  process.stderr.write(`smoke: --server, --user and --credential are required\n\n${USAGE}`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "_");
const plugin = path.resolve(values.plugin);
const options = {
  server: values.server,
  user: values.user,
  credential: path.resolve(values.credential),
  owner: values.owner,
  plugin,
  station: values.station ? path.resolve(values.station) : fs.existsSync(path.join(plugin, "station.json")) ? path.join(plugin, "station.json") : path.join(FIXTURE, "station.json"),
  class: values.class,
  word: values.word,
  minutes: Number(values.minutes),
  dir: values.dir ? path.resolve(values.dir) : path.join(os.tmpdir(), `kitchen-smoke-${stamp}`),
  database: `kitchen_smoke_${stamp}`,
  /** The station's wall-clock timeout: one turn may not outlive it. */
  turnTimeout: "10m",
};
if (!Number.isFinite(options.minutes) || options.minutes <= 0) {
  process.stderr.write(`smoke: --minutes must be a positive number, got ${values.minutes}\n`);
  process.exit(2);
}

const configHome = path.join(options.dir, "config");
const stateHome = path.join(options.dir, "state");
const spaceDir = path.join(configHome, "kitchen", "space");
const logFile = path.join(stateHome, "kitchen", "expeditor.jsonl");
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(stateHome, { recursive: true });

const say = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

/** One kitchen command, over the run's own config and state; the host's HOME stays, so claude keeps its login. */
function kitchen(args: string[], extraEnv: Record<string, string> = {}): Exit {
  const run = spawnSync(process.execPath, [KITCHEN, ...args], {
    cwd: options.dir,
    env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, ...extraEnv },
    encoding: "utf8",
  });
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** The exit of a kitchen command that had to succeed; the check fails with its stderr otherwise. */
function succeeded(name: string, exit: Exit): Exit {
  if (exit.status !== 0) throw new Error(`${name} exited ${exit.status}: ${exit.stderr.trim()}`);
  return exit;
}

/** One bd command over the space kitchen init wrote, under the owner's actor. */
function bdRun(args: string[]): Exit {
  const run = spawnSync("bd", ["--actor", options.owner, ...args], {
    cwd: spaceDir,
    env: { ...process.env, BEADS_CREDENTIALS_FILE: options.credential },
    encoding: "utf8",
  });
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** A read of the space: bd --json. */
function bd<T>(args: string[]): T {
  const run = bdRun([...args, "--json"]);
  if (run.status !== 0) throw new Error(`bd ${args.join(" ")} failed (exit ${run.status}): ${run.stderr.trim()}`);
  return JSON.parse(run.stdout || "null") as T;
}

const show = (id: string): Bead => {
  const [bead] = bd<Bead[]>(["show", id]);
  if (!bead) throw new Error(`bd show ${id} answered no bead`);
  return bead;
};
/** The order's children: its phases, and its passes, which bd list answers only when asked for gates by type. */
const children = (order: string): Bead[] => [
  ...(bd<Bead[] | null>(["list", "--parent", order, "--all", "--limit", "0"]) ?? []),
  ...(bd<Bead[] | null>(["list", "--parent", order, "--type", "gate", "--all", "--limit", "0"]) ?? []),
];
const version = (command: string, ...args: string[]): string => (spawnSync(command, args, { encoding: "utf8" }).stdout ?? "").trim().split("\n")[0] ?? "";

/** The expeditor log's turn lines so far, in order. */
function turnLines(): TurnLine[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.step === "turn" && typeof entry.phase === "string" && "outcome" in entry)
    .map((entry) => entry as unknown as TurnLine);
}

/** The failure of a turn as a check reports it: BLOCKED when claude itself could not run on this host (no login, no key), FAIL otherwise. */
function turnFailure(why: string, line: TurnLine | undefined): Error {
  const result = line?.result ?? "";
  const message = `${why}; last turn: exit ${line?.exit}, ${line?.failure ?? ""}: ${result || "(no result line)"}`;
  return /not logged in|invalid api key|please run \/login|authentication/i.test(result) ? new Blocked(`claude is not signed in on this host: ${message}`) : new Error(message);
}

/** One expeditor tick, waited for with the turns it started; the counts from its last line. */
function tick(): { started: number; stdout: string } {
  const run = succeeded("kitchen up --foreground --once", kitchen(["up", "--foreground", "--once"]));
  const counts = /started (\d+), waiting \d+, ended (\d+)/.exec(run.stdout);
  return { started: Number(counts?.[1] ?? 0), stdout: run.stdout.trim() };
}

/** Ticks until the condition holds, a turn failed twice, or the bound runs out. */
function tickUntil(done: () => boolean, what: string): void {
  const deadline = Date.now() + options.minutes * 60_000;
  while (true) {
    say(`  ${tick().stdout}`);
    if (done()) return;
    const failed = turnLines().filter((line) => line.outcome === "failed");
    const last = failed[failed.length - 1];
    if (last && failed.filter((line) => line.phase === last.phase).length >= 2) throw turnFailure(`turn failed twice on ${last.phase}`, last);
    if (Date.now() >= deadline) throw new Error(`${what} not reached within ${options.minutes} minutes; last turn: ${JSON.stringify(turnLines().at(-1) ?? null)}`);
  }
}

const checks: Check[] = [];
const created: Created = {};
let stopped: string | undefined;

/** What an earlier check created; a check that reaches here without it is a smoke defect. */
function need<K extends keyof Created>(key: K): NonNullable<Created[K]> {
  const value = created[key];
  if (value === undefined) throw new Error(`smoke: ${key} was not created by an earlier check`);
  return value;
}

/** Runs one check and records it; after a FAIL or a BLOCKED the checks that depend on it are not reached. */
function check(name: string, run: () => string): void {
  if (stopped !== undefined) {
    checks.push({ name, result: "BLOCKED", evidence: `not reached: ${stopped}` });
    return;
  }
  say(`${name}`);
  try {
    const evidence = run();
    checks.push({ name, result: "PASS", evidence });
    say(`  PASS: ${evidence}`);
  } catch (error) {
    const result: Result = error instanceof Blocked ? "BLOCKED" : "FAIL";
    const evidence = error instanceof Error ? error.message : String(error);
    checks.push({ name, result, evidence });
    stopped = `${name} ${result}`;
    say(`  ${result}: ${evidence}`);
  }
}

/** The first capture of the pattern in a command's output, which has to be there. */
const capture = (text: string, pattern: RegExp, what: string): string => {
  const match = pattern.exec(text);
  if (!match?.[1]) throw new Error(`${what}: expected ${pattern} in:\n${text.trim()}`);
  return match[1];
};

/** The three passes Kitchen itself lays, by title; the recipe's pass is any other human gate. */
const kitchenLaid = (bead: Bead): boolean => bead.issue_type === "gate" && KITCHEN_LAID.some((title) => bead.title.startsWith(`${title} `) || bead.title.startsWith(`${title}:`));
const recipePass = (bead: Bead): boolean => bead.issue_type === "gate" && bead.await_type === "human" && !kitchenLaid(bead);

say(`Kitchen smoke ${stamp}`);
say(`  kitchen: ${version("git", "-C", ROOT, "rev-parse", "--short", "HEAD")} at ${ROOT}`);
say(`  bd: ${version("bd", "version")}`);
say(`  claude: ${version("claude", "--version")}`);
say(`  node: ${process.version}`);
say(`  server: ${options.server} as ${options.user}; database: ${options.database}; owner: ${options.owner}`);
say(`  plugin: ${options.plugin}; station template: ${options.station}; class: ${options.class}; word: ${options.word}`);
say(`  run directory: ${options.dir}`);

if (!fs.existsSync(KITCHEN)) {
  say(`smoke: ${KITCHEN} is missing: run npm run build first`);
  process.exit(2);
}

check("1. kitchen init creates the smoke's own database and the space", () => {
  const init = succeeded("kitchen init", kitchen(["init", "--server", options.server, "--owner", options.owner, "--user", options.user, "--database", options.database, "--credential", options.credential]));
  // What scripts/install-server.sh configures for the team space, done here for the smoke's database.
  for (const [key, value] of [["types.custom", "phase,station,source"], ["events-journal", "true"]]) {
    const set = bdRun(["config", "set", key ?? "", value ?? ""]);
    if (set.status !== 0) throw new Error(`bd config set ${key} failed: ${set.stderr.trim()}`);
  }
  const beads = bd<Bead[] | null>(["list", "--all", "--limit", "0"]) ?? [];
  if (beads.length !== 0) throw new Error(`the new database ${options.database} holds ${beads.length} beads already`);
  return `${init.stdout.trim()}; ${options.database} is empty`;
});

check("2. kitchen recipe add registers the recipe from the plugin directory", () => {
  const add = succeeded("kitchen recipe add", kitchen(["recipe", "add", options.plugin]));
  created.recipe = capture(add.stdout, /Registered (\S+) rev:/, "the recipe name");
  created.revision = capture(add.stdout, /Registered \S+ (rev:[0-9a-f]+)/, "the revision");
  const phases = bd<Bead[] | null>(["list", "--type", "phase", "--limit", "0"]) ?? [];
  if (!phases.length) throw new Error("no phase beads after registration");
  created.phases = phases.map((p) => `${p.id} ${p.title}`);
  return `${add.stdout.trim()}; phase beads: ${phases.map((p) => p.id).join(", ")}`;
});

check("3. kitchen station add registers one unattended station on this host", () => {
  const add = succeeded("kitchen station add", kitchen(["station", "add", options.station, "--cap", "1", "--timeout", options.turnTimeout]));
  created.station = capture(add.stdout, /Registered station (\S+) as /, "the station title");
  created.stationBead = capture(add.stdout, /Registered station \S+ as (\S+) on /, "the station bead");
  const bead = show(created.stationBead);
  if (bead.labels?.includes("attended")) throw new Error(`${bead.id} is attended; the smoke's station is unattended`);
  return `${add.stdout.trim()}; labels ${bead.labels?.join(", ")}`;
});

check("4. kitchen order add lays the entry phase and assigns it mechanically to the station", () => {
  const sentence = `Smoke ${stamp}: greet the kitchen, then confirm the answer`;
  const add = succeeded("kitchen order add", kitchen(["order", "add", sentence, "--recipe", need("recipe"), "--class", options.class]));
  if (/No station for/.test(add.stdout)) throw new Error(add.stdout.trim());
  created.order = capture(add.stdout, /Added order (\S+) /, "the order id");
  created.entry = capture(add.stdout, /Laid \S+ as (\S+) at /, "the entry phase id");
  const entry = show(created.entry);
  if (entry.assignee !== need("station")) throw new Error(`${entry.id} is assigned to ${entry.assignee}, not ${need("station")}`);
  if (!/^entry: mechanical$/m.test(entry.notes ?? "")) throw new Error(`${entry.id} carries no "entry: mechanical" note`);
  return add.stdout.trim().replace(/\n/g, "; ");
});

check("5. the order reaches its first pass with a brief, laid and assigned by a turn", () => {
  const order = need("order");
  const station = need("station");
  tickUntil(() => children(order).some((bead) => recipePass(bead) || kitchenLaid(bead)), "the first pass");
  const laid = children(order).find(kitchenLaid);
  if (laid) throw turnFailure(`${laid.id} (${laid.title}) was laid instead of the recipe's pass`, turnLines().at(-1));
  const pass = children(order).find(recipePass);
  if (!pass) throw new Error("no pass");
  created.pass = pass.id;
  if (pass.status !== "open") throw new Error(`${pass.id} is ${pass.status}, not open`);
  const brief = /Reason: ([\s\S]+)$/.exec(pass.description ?? "")?.[1]?.trim();
  if (!brief) throw new Error(`${pass.id} carries no brief (no Reason: in its description)`);
  if (pass.created_by !== station) throw new Error(`${pass.id} was created by ${pass.created_by}, not by the station's turn ${station}`);
  const blockedByPass = (bead: Bead): boolean => bead.issue_type === "task" && bead.id !== created.entry && (show(bead.id).dependencies ?? []).some((dep) => dep.id === pass.id);
  const behind = children(order).find(blockedByPass);
  if (!behind) throw new Error(`no phase behind ${pass.id}: the pass and the phase behind it land in the same close-out`);
  created.behind = behind.id;
  if (behind.assignee !== station) throw new Error(`${behind.id} is assigned to ${behind.assignee}, not ${station}`);
  if (behind.created_by !== station) throw new Error(`${behind.id} was created by ${behind.created_by}, not by the turn`);
  if (!/^assigned: /m.test(behind.notes ?? "")) throw new Error(`${behind.id} carries no "assigned:" note saying why`);
  const entry = show(need("entry"));
  if (entry.status !== "closed") throw new Error(`the entry phase ${entry.id} is ${entry.status}, not closed`);
  return `pass ${pass.id} (${pass.title}) by ${pass.created_by}, brief: "${brief.split("\n")[0]}"; phase behind ${behind.id} (${behind.title}) assigned to ${behind.assignee}; entry ${entry.id} closed`;
});

check("6. a station actor cannot close the pass through kitchen pass", () => {
  const refused = kitchen(["pass", need("pass"), options.word], { BEADS_ACTOR: need("station") });
  if (refused.status === 0) throw new Error(`kitchen pass under ${need("station")} exited 0: ${refused.stdout.trim()}`);
  const pass = show(need("pass"));
  if (pass.status !== "open") throw new Error(`${pass.id} is ${pass.status} after the refused close`);
  return `exit ${refused.status}: ${refused.stderr.trim().split("\n")[0]}; ${pass.id} still open`;
});

check("7. the human closes the pass with the word", () => {
  succeeded("kitchen pass", kitchen(["pass", need("pass"), options.word]));
  const pass = show(need("pass"));
  if (pass.status !== "closed") throw new Error(`${pass.id} is ${pass.status}, not closed`);
  if (pass.close_reason !== options.word) throw new Error(`${pass.id} closed with "${pass.close_reason}", not "${options.word}"`);
  if (pass.closed_by !== undefined && pass.closed_by !== options.owner) throw new Error(`${pass.id} was closed by ${pass.closed_by}, not ${options.owner}`);
  return `${pass.id} closed by ${pass.closed_by ?? options.owner} with "${pass.close_reason}"`;
});

check("8. the phase behind the pass runs and applies the answer once", () => {
  const behind = need("behind");
  tickUntil(() => show(behind).status === "closed", `the close of ${behind}`);
  const pass = show(need("pass"));
  if (!pass.labels?.includes("applied")) throw new Error(`${pass.id} is not labelled applied after ${behind} closed`);
  const answers = () => (show(need("order")).notes ?? "").split("\n").filter((line) => line.startsWith("answer:"));
  if (answers().length !== 1 || answers()[0] !== `answer: ${options.word}`) throw new Error(`the order's answer lines read ${JSON.stringify(answers())}, expected one "answer: ${options.word}"`);
  const turns = turnLines().filter((line) => line.phase === behind);
  if (turns.length !== 1) throw new Error(`${turns.length} turns ran on ${behind}: ${JSON.stringify(turns)}`);
  // A repeated tick applies nothing twice and starts nothing: the phase is closed and the pass applied.
  const again = tick();
  say(`  ${again.stdout}`);
  if (again.started !== 0) throw new Error(`a tick after the close started ${again.started} turns`);
  if (answers().length !== 1) throw new Error(`a repeated tick left ${answers().length} answer lines`);
  return `${behind} closed after one turn (exit ${turns[0]?.exit}: ${turns[0]?.result}); ${pass.id} labelled applied; one "answer: ${options.word}" line; a further tick started nothing`;
});

check("9. the order closes with its result line", () => {
  const order = show(need("order"));
  if (order.status !== "closed") throw new Error(`${order.id} is ${order.status}: ${order.notes ?? ""}`);
  if (!/^Order done: /.test(order.close_reason ?? "")) throw new Error(`${order.id} closed with "${order.close_reason}", not an "Order done:" line`);
  return `${order.id} closed: ${order.close_reason}`;
});

say("");
say("Bead ids:");
say(`  database: ${options.database}`);
for (const [name, value] of Object.entries(created)) say(`  ${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
say(`Expeditor log: ${logFile}`);
say(`Database left on ${options.server}: ${options.database} (drop it by hand when the record is written)`);
say("");
say("Run record rows:");
say("| Check | Result | Evidence / bead IDs / follow-up |");
say("| --- | --- | --- |");
for (const entry of checks) say(`| ${entry.name} | ${entry.result} | ${entry.evidence.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
const verdict = checks.every((entry) => entry.result === "PASS") ? "PASS" : checks.some((entry) => entry.result === "FAIL") ? "FAIL" : "BLOCKED";
say("");
say(`Smoke ${verdict}`);
process.exit(verdict === "PASS" ? 0 : 1);
