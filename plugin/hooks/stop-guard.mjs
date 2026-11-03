#!/usr/bin/env node
// The Stop hook of the Kitchen plugin, ported from Umka's stop guard: a turn does not end while a
// background command it started still runs. Reads the Stop event on stdin; prints a block decision
// naming each task in flight, and nothing when the session is free to end.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const inFlight = /^(running|pending|backgrounded)$/i;

export function decide(event) {
  const tasks = (event.background_tasks ?? []).filter((t) => inFlight.test(t.status ?? ""));
  if (tasks.length === 0) return null;
  const lines = tasks.map((t) => `- ${t.type}${t.command ? `: ${t.command}` : t.description ? `: ${t.description}` : ""}`);
  const reason = [
    `Work this turn started is still running (${tasks.length}):`,
    ...lines,
    "Wait for it in the foreground: poll its output until the process exits. A Monitor task is itself background work, so it does not count as waiting. Then close out and end the turn.",
  ].join("\n");
  return { decision: "block", reason };
}

const samePath = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};
// The plugin may be reached through a symlink: argv keeps the link, import.meta.url the real path.
const isMain = process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let event = {};
    try {
      event = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      process.exit(0);
    }
    const out = decide(event);
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  });
}
