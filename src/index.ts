// The package surface: the CLI entry, the two seams later slices and tests build on, the actor and the space.
export { main, help, COMMANDS } from "./cli.ts";
export type { CliDeps, Command } from "./cli.ts";
export { humanActor, stationActor, expeditorActor, actorName, parseActor, resolveActor } from "./actor.ts";
export type { Actor } from "./actor.ts";
export { openSpace, RefusedError, SpaceError, REGISTERED_TYPES } from "./space.ts";
export type { Space, SpaceDeps, Bead, BeadRef, CreateFields, UpdateFields, ReadyFilter, GateFields, JournalEvent } from "./space.ts";
export { processRunner } from "./runner.ts";
export type { CommandRunner, CommandResult, CommandOptions } from "./runner.ts";
export { systemClock } from "./clock.ts";
export type { Clock } from "./clock.ts";
