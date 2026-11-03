// The Kitchen plugin directory the runner loads: exactly two things, the `kitchen:turn` skill and the
// Stop hook, plus the bin helper the skill calls. Read as files, the way Claude Code discovers them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const plugin = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "plugin");
const read = (...parts: string[]) => fs.readFileSync(path.join(plugin, ...parts), "utf8");

test("the manifest names the plugin kitchen, so the skill is reached as kitchen:turn", () => {
  const manifest = JSON.parse(read(".claude-plugin", "plugin.json")) as { name: string; version: string; description: string };
  assert.equal(manifest.name, "kitchen");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.description, /turn driver/);
});

test("the plugin ships the turn skill and the Stop hook and nothing else: no commands, agents or phases", () => {
  const entries = fs.readdirSync(plugin).sort();
  assert.deepEqual(entries, [".claude-plugin", "bin", "hooks", "skills"]);
  assert.deepEqual(fs.readdirSync(path.join(plugin, "skills")), ["turn"]);
  assert.deepEqual(fs.readdirSync(path.join(plugin, "hooks")).sort(), ["hooks.json", "stop-guard.mjs"]);
  assert.deepEqual(fs.readdirSync(path.join(plugin, "bin")), ["lay.mjs"]);
});

test("the hooks file registers the Stop hook alone, run with node from the plugin root", () => {
  const hooks = JSON.parse(read("hooks", "hooks.json")) as { hooks: Record<string, { hooks: { type: string; command: string }[] }[]> };
  assert.deepEqual(Object.keys(hooks.hooks), ["Stop"]);
  const [entry] = hooks.hooks.Stop ?? [];
  assert.deepEqual(entry?.hooks, [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-guard.mjs"' }]);
});

// The prose of the skill is exercised by the smoke, not here; what this pins is its shape: the name
// Claude Code reaches it by, the argument, the five numbered steps of the turn driver, and the helper.
test("the turn skill is named turn, takes the phase id, walks the five numbered steps and calls the lay helper from the plugin root", () => {
  const skill = read("skills", "turn", "SKILL.md");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
  assert.match(frontmatter, /^name: turn$/m);
  assert.match(frontmatter, /^argument-hint: .*phase/m);
  const steps = [...skill.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
  assert.deepEqual(steps, ["1. Claim", "2. Reconcile", "3. Work", "4. Close out", "5. Result line"]);
  assert.match(skill, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/lay\.mjs"/);
});
