// The human's word on a pass Kitchen itself laid (spec: Answers). A recipe's pass carries an Apply
// section the turn behind it runs; the three passes Kitchen lays (`no station for <phase>`, `rounds
// reached: <phase>`, `turn failed: <phase>`) carry none, so the expeditor applies their word on tick:
// `retry` reopens the phase behind the pass with its failure count cleared, `retry <station title>`
// moves it to that station as well, `stop` closes the order with the word, and any other word leaves
// the pass closed and the order open with a note saying the human continues by hand. The pass is
// labelled `applied` afterwards, so a restart or a repeated tick applies nothing twice.
import { labelValue } from "../fields.ts";
import { NO_STATION } from "../intake.ts";
import { FAILED, failures } from "../laid.ts";
import type { Bead, Space } from "../space.ts";
import { TURN_FAILED } from "./turn.ts";

/** The label on a pass whose word has been applied, by the expeditor or by the turn behind it. */
export const APPLIED = "applied";

/** The pass the turn driver lays when a phase's `rounds` cap is reached. */
export const ROUNDS_REACHED = "rounds reached";

/** The titles of the passes Kitchen lays, each followed by the phase slug. */
export const KITCHEN_LAID: readonly string[] = [NO_STATION, ROUNDS_REACHED, TURN_FAILED];

/** Whether a gate is a pass Kitchen laid: a human gate titled after one of the three. */
export function kitchenLaid(gate: Bead): boolean {
  return gate.await_type === "human" && KITCHEN_LAID.some((title) => gate.title.startsWith(`${title} `) || gate.title.startsWith(`${title}:`));
}

/** The human's word on a closed pass, as its close reason reads. */
export type Word =
  | { kind: "retry"; station?: string }
  | { kind: "stop" }
  | { kind: "note"; word: string };

export function parseWord(reason: string): Word {
  const word = reason.trim();
  const [first, ...rest] = word.split(/\s+/);
  if (first?.toLowerCase() === "retry") return rest.length ? { kind: "retry", station: rest.join(" ") } : { kind: "retry" };
  if (word.toLowerCase() === "stop") return { kind: "stop" };
  return { kind: "note", word };
}

/** What applying one word did, for the log. */
export interface Applied {
  pass: string;
  word: string;
  applied: Word["kind"];
  order?: string;
  /** The phases reopened by `retry`. */
  phases?: string[];
  /** The station `retry <station title>` moved them to. */
  station?: string;
  /** The beads `stop` closed: the order's open phases, then the order. */
  closed?: string[];
}

/** Applies the word of one closed Kitchen-laid pass and labels the pass applied. */
export async function applyWord(space: Space, pass: Bead, owner: string): Promise<Applied> {
  const reason = typeof pass.close_reason === "string" ? pass.close_reason : "";
  const word = parseWord(reason);
  const done: Applied = { pass: pass.id, word: reason, applied: word.kind };
  const phases = (await space.blocked(pass.id)).filter((bead) => bead.issue_type !== "epic");
  const order = typeof pass.parent === "string" && pass.parent !== "" ? pass.parent : phases.map((phase) => phase.parent).find((parent): parent is string => typeof parent === "string" && parent !== "");
  if (order !== undefined) done.order = order;

  if (word.kind === "retry") {
    done.phases = [];
    if (word.station !== undefined) done.station = word.station;
    for (const phase of phases) {
      await space.update(phase, { ...reopened(phase), ...(word.station === undefined ? {} : moved(phase, word.station)) });
      done.phases.push(phase.id);
    }
  } else if (word.kind === "stop") {
    done.closed = [];
    if (order !== undefined) {
      // bd refuses to close an epic with open children: the order's open phases close first, with the same word.
      for (const child of (await space.list({ parent: order })).filter((bead) => bead.issue_type !== "gate" && bead.status !== "closed")) {
        await space.close(child, reason);
        done.closed.push(child.id);
      }
      await space.close({ id: order, issue_type: "epic" }, reason);
      done.closed.push(order);
    }
  } else if (order !== undefined) {
    await space.update({ id: order, issue_type: "epic" }, {
      appendNotes: `${pass.id} (${pass.title}) closed with "${word.word}", neither retry nor stop: the order stays open for ${owner} to continue by hand`,
    });
  }

  await space.update(pass, { addLabels: [APPLIED] });
  return done;
}

/** Open again, the failure count gone. */
function reopened(phase: Bead) {
  const count = failures(phase);
  return { status: "open", removeLabels: count ? [`${FAILED}:${count}`] : [] };
}

/** Assigned to another station, the `station:` label following, so a reclaim restores it there. */
function moved(phase: Bead, station: string) {
  const from = labelValue(phase, "station");
  const count = failures(phase);
  return {
    assignee: station,
    addLabels: [`station:${station}`],
    removeLabels: [...(count ? [`${FAILED}:${count}`] : []), ...(from !== undefined && from !== station ? [`station:${from}`] : [])],
  };
}
