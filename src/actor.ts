// The actor: who a write is made as. A person writes as their name, a turn as owner/station, the
// expeditor as owner/expeditor. Provenance only; ADR 0003 and docs/trust-model.md say where that ends.
import type { HostConfig } from "./config.ts";

export type Actor =
  | { kind: "human"; owner: string }
  | { kind: "station"; owner: string; station: string }
  | { kind: "expeditor"; owner: string };

export const EXPEDITOR = "expeditor";

export function humanActor(owner: string): Actor {
  return { kind: "human", owner };
}

/** The turn actor: the station title `<owner>/<station>`, so a claim under it assigns the station itself. */
export function stationActor(owner: string, station: string): Actor {
  return { kind: "station", owner, station };
}

export function expeditorActor(owner: string): Actor {
  return { kind: "expeditor", owner };
}

/** The name written after `--actor`. */
export function actorName(actor: Actor): string {
  switch (actor.kind) {
    case "human":
      return actor.owner;
    case "station":
      return `${actor.owner}/${actor.station}`;
    case "expeditor":
      return `${actor.owner}/${EXPEDITOR}`;
  }
}

/** Reads an actor back from its name: `sona`, `sona/grill`, `sona/expeditor`. */
export function parseActor(name: string): Actor {
  const slash = name.indexOf("/");
  if (slash === -1) return humanActor(name);
  const owner = name.slice(0, slash);
  const station = name.slice(slash + 1);
  return station === EXPEDITOR ? expeditorActor(owner) : stationActor(owner, station);
}

/**
 * The actor of the current context. A session the runner started carries its station in
 * `BEADS_ACTOR`, which bd itself reads for its default; a person at a CLI carries nothing and
 * writes as the host config's owner.
 */
export function resolveActor(env: Record<string, string | undefined>, config: Pick<HostConfig, "owner">): Actor {
  const name = env.BEADS_ACTOR;
  return name ? parseActor(name) : humanActor(config.owner);
}
