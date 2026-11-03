// kitchen pass: the terminal's Pass view (spec: Human surfaces; stories 61, 62, 64). Lists every open
// briefed pass with its order and brief, takes the chosen one and the human's word, and closes the gate
// with the word as its reason. The close is a person's: a session running as a station or as the
// expeditor is refused here before any call, as the space wrapper would refuse the close itself.
// `kitchen pass <pass> <word...>` answers without a question, for scripts and the smoke.
import readline from "node:readline";
import { parseArgs } from "node:util";
import { actorName } from "../actor.ts";
import type { CliDeps, Command } from "../cli.ts";
import type { Order } from "../order.ts";
import { nameOrder, readOrders, readPasses } from "../pass.ts";
import type { Pass } from "../pass.ts";
import { RefusedError, RULE, SpaceError } from "../space.ts";
import { openHostSpace } from "./host-space.ts";

const USAGE = `Usage: kitchen pass [<pass> [<word>...]]

Lists every open briefed pass with its order and brief. With no arguments it asks which pass to
answer and for your word, and closes that pass with the word as its reason; an empty answer leaves
every pass open. With a pass id and a word it closes that pass without asking. The close is yours:
a session Kitchen started (one running as a station or as the expeditor) is refused.
`;

export const pass: Command = async (args, deps) => {
  const fail = (message: string, usage = false): number => {
    deps.stderr(`kitchen pass: ${message}\n${usage ? `\n${USAGE}` : ""}`);
    return 1;
  };
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout(USAGE);
    return 0;
  }
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), true);
  }
  const [chosen, ...words] = positionals;

  const opened = openHostSpace(deps);
  if ("error" in opened) return fail(opened.error, true);
  const { space } = opened;
  if (space.actor.kind !== "human") {
    return fail(`${actorName(space.actor)} may not answer a pass: a pass closes only under a person's name (${RULE})`);
  }

  let passes: Pass[];
  let orders: Map<string, Order>;
  try {
    passes = await readPasses(space);
    orders = await readOrders(space);
  } catch (error) {
    if (error instanceof SpaceError) return fail(error.message);
    throw error;
  }
  const briefed = passes.filter((p) => p.brief !== undefined);
  const prompt = questions(deps);

  let target: Pass | undefined;
  if (chosen === undefined) {
    deps.stdout(listing(briefed, passes, orders, space.actor.owner));
    if (!briefed.length || !deps.stdin) return 0;
    const answer = await prompt.ask("Pass (number or id, empty to leave them open): ");
    if (!answer) {
      deps.stdout("No pass closed.\n");
      return 0;
    }
    target = briefed[Number(answer) - 1] ?? passes.find((p) => p.id === answer);
    if (!target) return fail(`${answer} is not an open pass`);
  } else {
    target = passes.find((p) => p.id === chosen);
    if (!target) return fail(`${chosen} is not an open pass: kitchen pass lists them`);
  }

  let word = words.join(" ").trim();
  if (!word) {
    if (!target.brief) deps.stdout(`${target.id} (${target.title}) on order ${nameOrder(target.order, orders)} carries no brief yet.\n`);
    else if (chosen !== undefined) deps.stdout(`${describe(target, orders)}\n`);
    word = (await prompt.ask("Your word: ")) ?? "";
  }
  if (!word) return fail(`a word is required: ${target.id} stays open`);

  try {
    await space.close(target.ref, word);
  } catch (error) {
    if (error instanceof RefusedError || error instanceof SpaceError) return fail(error.message);
    throw error;
  }
  deps.stdout(`Closed ${target.id} (${target.title}) on order ${nameOrder(target.order, orders)} with: ${word}\nThe phase behind it is ready for the next tick.\n`);
  return 0;
};

/** The Pass view: the briefed passes numbered, each with its order and brief; the unbriefed ones named after. */
function listing(briefed: Pass[], passes: Pass[], orders: Map<string, Order>, owner: string): string {
  const unbriefed = passes.filter((p) => p.brief === undefined);
  const lines: string[] = [];
  if (!briefed.length) lines.push(`No open briefed pass for ${owner}.`);
  else {
    lines.push(`${briefed.length} open ${briefed.length === 1 ? "pass" : "passes"} for ${owner}:`, "");
    briefed.forEach((p, i) => lines.push(`${i + 1}. ${describe(p, orders)}`, ""));
  }
  if (unbriefed.length) lines.push(`Not yet briefed: ${unbriefed.map((p) => `${p.id} (${p.title})`).join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/** One pass: id and title, its order on the next line, then the brief indented. */
function describe(pass: Pass, orders: Map<string, Order>): string {
  const brief = (pass.brief ?? "").split("\n").map((line) => `   ${line}`);
  return [`${pass.id}  ${pass.title}`, `   order ${nameOrder(pass.order, orders)}`, ...brief].join("\n");
}

/** The questions a run asks, read line by line from the terminal's input; nothing when there is none. */
function questions(deps: CliDeps): { ask(question: string): Promise<string | undefined> } {
  let lines: AsyncIterator<string> | undefined;
  return {
    async ask(question) {
      if (!deps.stdin) return undefined;
      deps.stdout(question);
      lines ??= readline.createInterface({ input: deps.stdin, terminal: false })[Symbol.asyncIterator]();
      const next = await lines.next();
      return next.done ? undefined : next.value.trim();
    },
  };
}
