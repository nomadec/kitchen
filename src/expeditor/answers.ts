// The human's word on a pass Kitchen itself laid (spec: Answers). A recipe's pass carries an Apply
// section the turn behind it runs; the three passes Kitchen lays (`no station for <phase>`, `rounds
// reached: <phase>`, `turn failed: <phase>`) carry none, so the expeditor applies their word on tick:
// `retry` reopens the phase behind the pass with its failure count cleared, `retry <station title>`
// moves it to that station as well (one registered to the owner that lacks nothing the phase needs;
// any other title leaves the phase as it is, noted on the order), `stop` closes the order with the
// word, and any other word leaves
// the pass closed and the order open with a note saying the human continues by hand. A phase laid
// unassigned behind a `no station for` pass is assigned on `retry` by intake's mechanical choice
// again, among the owner's stations as they are now; still none, and a new pass names the gap. The
// pass is labelled `applied` afterwards, so a restart or a repeated tick applies nothing twice.
import { parseActor } from "../actor.ts";
import { labelValue, noteLine } from "../fields.ts";
import { chooseStation, describeGap, layNoStationPass, NO_STATION } from "../intake.ts";
import { FAILED, failures } from "../laid.ts";
import { parseOrder } from "../order.ts";
import { readStations } from "../registered.ts";
import type { Bead, BeadRef, Space, UpdateFields } from "../space.ts";
import { lacks } from "../station.ts";
import type { Need } from "../station.ts";
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

/**
 * Reads the word: `retry`, `retry <station title>` (the title must read as a station actor,
 * `<owner>/<station>`; `retry later` is some other word), `stop`, or anything else, which is noted.
 */
export function parseWord(reason: string): Word {
  const word = reason.trim();
  const [first, ...rest] = word.split(/\s+/);
  if (first?.toLowerCase() === "retry") {
    if (!rest.length) return { kind: "retry" };
    const station = rest.join(" ");
    if (rest.length === 1 && parseActor(station).kind === "station") return { kind: "retry", station };
  } else if (word.toLowerCase() === "stop") {
    return { kind: "stop" };
  }
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
  /** The station `retry <station title>` moved them to, or the one the mechanical choice assigned an unassigned phase to. */
  station?: string;
  /** The `no station for` pass laid again when `retry` found no station for an unassigned phase. */
  relaid?: string;
  /** The beads `stop` closed: the order's open phases, then the order. */
  closed?: string[];
}

/** Applies the word of one closed Kitchen-laid pass and labels the pass applied. */
export async function applyWord(space: Space, pass: Bead, owner: string): Promise<Applied> {
  const reason = typeof pass.close_reason === "string" ? pass.close_reason : "";
  const word = parseWord(reason);
  const done: Applied = { pass: pass.id, word: reason, applied: word.kind };
  const phases = (await space.blocks(pass.id)).filter((bead) => bead.issue_type !== "epic");
  const order = typeof pass.parent === "string" && pass.parent !== "" ? pass.parent : phases.map((phase) => phase.parent).find((parent): parent is string => typeof parent === "string" && parent !== "");
  if (order !== undefined) done.order = order;
  const byHand = (what: string): Promise<void> | undefined =>
    order === undefined ? undefined : space.update(orderRef(order), { appendNotes: `${pass.id} (${pass.title}) closed with "${reason.trim()}", ${what}: the order stays open for ${owner} to continue by hand` });

  if (word.kind === "retry") {
    done.phases = [];
    if (word.station !== undefined) done.station = word.station;
    for (const phase of phases) {
      let station: string | undefined;
      if (word.station !== undefined) {
        // The named station as the lay helper would take it: registered, and lacking nothing the
        // phase needs; a typo or a gap leaves the phase as it is rather than assigned to nothing.
        const gap = await unfit(space, word.station, phase, order, owner);
        if (gap !== undefined) {
          await byHand(gap);
          continue;
        }
        station = word.station;
      } else if (!assigned(phase)) {
        station = await chooseAgain(space, phase, order, owner, done);
        if (station === undefined) continue;
      }
      await space.update(phase, retried(phase, station));
      done.phases.push(phase.id);
    }
    if (!phases.length) await byHand("but no phase is laid behind the pass");
  } else if (word.kind === "stop") {
    done.closed = [];
    if (order !== undefined) {
      // bd refuses to close an epic with open children: the order's open phases close first, with the
      // same word. An open pass of another phase is left to its owner and makes bd refuse the order.
      for (const child of (await space.list({ parent: order })).filter((bead) => bead.issue_type !== "gate" && bead.status !== "closed")) {
        await space.close(child, reason);
        done.closed.push(child.id);
      }
      await space.close(orderRef(order), reason);
      done.closed.push(order);
    }
  } else {
    await byHand("neither retry nor stop");
  }

  await space.update(pass, { addLabels: [APPLIED] });
  return done;
}

/** Whether the phase is assigned to a station: one laid behind a `no station for` pass is not. */
function assigned(phase: Bead): boolean {
  return typeof phase.assignee === "string" && phase.assignee !== "";
}

/** What the phase needs of a station: its model note and its order's repositories. */
async function needOf(space: Space, phase: Bead, order: string | undefined): Promise<Need> {
  const repos = order === undefined ? [] : parseOrder(await space.show(order)).repos;
  return { model: noteLine(phase.notes ?? "", "model") || undefined, repos };
}

/** Why the station `retry <station title>` names cannot take the phase: not registered to the owner, or lacking what the phase needs; nothing when it can. */
async function unfit(space: Space, title: string, phase: Bead, order: string | undefined, owner: string): Promise<string | undefined> {
  const station = (await readStations(space, { owner })).find((s) => s.title === title);
  if (!station) return `but no station titled ${title} is registered to ${owner}`;
  const gap = lacks(station, await needOf(space, phase, order));
  if (gap.length) return `but ${title} lacks ${gap.join(", ")} for ${phase.id}`;
  return undefined;
}

/**
 * Intake's mechanical choice, made again for a phase laid unassigned: the owner's stations as they
 * are now, against the phase's model note and its order's repositories. None qualifying lays the
 * `no station for` pass again behind the phase, with the gap as it is now, and answers nothing.
 */
async function chooseAgain(space: Space, phase: Bead, order: string | undefined, owner: string, done: Applied): Promise<string | undefined> {
  const slug = labelValue(phase, "phase") ?? "";
  const need = await needOf(space, phase, order);
  const stations = await readStations(space, { owner });
  const chosen = await chooseStation(space, stations, need);
  if (chosen) {
    done.station = chosen.title;
    return chosen.title;
  }
  const gap = describeGap(owner, { slug }, need, stations);
  const relaid = await layNoStationPass(space, { order: order ?? (typeof phase.parent === "string" ? phase.parent : ""), phase: phase.id, slug, gap, owner });
  done.relaid = relaid.id;
  return undefined;
}

/** Open again with the failure count gone; moved to the station named, the `station:` label following so a reclaim restores it there. */
function retried(phase: Bead, station: string | undefined): UpdateFields {
  const count = failures(phase);
  const fields: UpdateFields = { status: "open", removeLabels: count ? [`${FAILED}:${count}`] : [] };
  if (station === undefined) return fields;
  const from = labelValue(phase, "station");
  return {
    ...fields,
    assignee: station,
    addLabels: from === station ? [] : [`station:${station}`],
    removeLabels: [...(fields.removeLabels ?? []), ...(from !== undefined && from !== station ? [`station:${from}`] : [])],
  };
}

function orderRef(id: string): BeadRef {
  return { id, issue_type: "epic" };
}
