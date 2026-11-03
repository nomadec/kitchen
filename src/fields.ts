// The two places a bead carries structured fields Kitchen reads: `<key>:<value>` labels and
// `<key>: <value>` lines of its notes.
import type { Bead } from "./space.ts";

/** The value of the bead's `<key>:<value>` label, if it carries one. */
export function labelValue(bead: Pick<Bead, "labels">, key: string): string | undefined {
  return bead.labels?.find((label) => label.startsWith(`${key}:`))?.slice(key.length + 1);
}

const isNoteLine = (key: string) => (line: string) => line.startsWith(`${key}:`);

/** The value of the `<key>: <value>` line of the notes, if there is one; empty when the line holds nothing. */
export function noteLine(notes: string, key: string): string | undefined {
  const line = notes.split("\n").find(isNoteLine(key));
  return line?.slice(key.length + 1).trim();
}

/** Replaces the key's line of the notes or appends one. */
export function withNoteLine(notes: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const lines = notes === "" ? [] : notes.split("\n");
  const at = lines.findIndex(isNoteLine(key));
  if (at === -1) lines.push(line);
  else lines[at] = line;
  return lines.join("\n");
}
