// A bundle: the phase files of one recipe as found on disk or fetched, and the revision that names
// their content. Discovery reads a plugin directory (`phases/*.md`, the recipe named by
// `.claude-plugin/plugin.json`), a directory of phase files, one file, or one file at a URL.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "../runner.ts";

/** One phase file as read: its name and its whole text. Parsing comes after discovery, so the lint sees every file. */
export interface PhaseFile {
  file: string;
  text: string;
}

export interface Bundle {
  recipe: string;
  files: PhaseFile[];
}

/** The length of the short content hash in the `rev:` label. */
const REVISION_LENGTH = 7;

/** The revision: a short hash of every file's name and text, in file-name order. */
export function revisionOf(files: readonly PhaseFile[]): string {
  const hash = createHash("sha256");
  for (const { file, text } of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    hash.update(`${file}\n${text}\0`);
  }
  return hash.digest("hex").slice(0, REVISION_LENGTH);
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

const needsRecipeName = (target: string) => new BundleError(`${target} is one phase file: name its recipe with --recipe <name>`);

/** The phase files of a plugin directory, a directory of phase files, or one file, with the recipe name. */
export function discover(target: string, recipe?: string): Bundle {
  if (!fs.existsSync(target)) throw new BundleError(`${target}: no such file or directory`);
  if (fs.statSync(target).isFile()) {
    if (!recipe) throw needsRecipeName(target);
    return { recipe, files: [readPhaseFile(target)] };
  }
  const phaseDir = fs.existsSync(path.join(target, "phases")) ? path.join(target, "phases") : target;
  const names = fs.readdirSync(phaseDir).filter((name) => name.endsWith(".md")).sort();
  if (names.length === 0) throw new BundleError(`${phaseDir}: no phase files (*.md)`);
  return {
    recipe: recipe ?? pluginName(target) ?? path.basename(path.resolve(target)),
    files: names.map((name) => readPhaseFile(path.join(phaseDir, name))),
  };
}

/** One phase file fetched over the runner with curl; the file name is the URL's last segment. */
export async function fetchBundle(url: string, recipe: string | undefined, runner: CommandRunner): Promise<Bundle> {
  if (!recipe) throw needsRecipeName(url);
  const file = path.basename(new URL(url).pathname);
  if (!file.endsWith(".md")) throw new BundleError(`${url} does not end in a phase file name (<slug>.md)`);
  const result = await runner(["curl", "-fsSL", url]);
  if (result.exitCode !== 0) throw new BundleError(`could not fetch ${url}: ${result.stderr.trim()}`);
  return { recipe, files: [{ file, text: result.stdout }] };
}

function readPhaseFile(file: string): PhaseFile {
  return { file: path.basename(file), text: fs.readFileSync(file, "utf8") };
}

/** The `name` of `.claude-plugin/plugin.json`, when the directory is a plugin. */
function pluginName(dir: string): string | undefined {
  const manifest = path.join(dir, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) return undefined;
  const { name } = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
  return typeof name === "string" && name !== "" ? name : undefined;
}
