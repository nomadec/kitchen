// An item is one thing that can become an order: a GitHub issue URL, a file path or free text, as
// `kitchen order add` takes it on the command line and as a JSONL source yields it one per line. Reading
// it gives intake the source shape, the class it would enter with when nothing says otherwise, and the
// repositories it implies.
import fs from "node:fs";
import path from "node:path";
import { IntakeError } from "./intake.ts";
import type { OrderSource } from "./order.ts";
import type { CommandRunner } from "./runner.ts";
import type { OrderClass } from "./source.ts";

const GITHUB_ISSUE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?(?:[#?].*)?$/;

/** What `gh issue view --json title,body,url,labels` prints. */
interface IssueView {
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
}

/** What intake needs of an item: the source shape and the repositories the order names. */
export interface Item {
  source: OrderSource;
  repos: string[];
}

/** An item as read, with the class it would enter with when no class is given. */
export interface ReadItem extends Item {
  inferred: OrderClass;
}

/** Reads an item: a GitHub issue through gh, a file from disk, anything else as the sentence itself. */
export async function readItem(target: string, runner: CommandRunner): Promise<ReadItem> {
  const issue = GITHUB_ISSUE.exec(target);
  if (issue) {
    const [, owner, repo, number] = issue;
    const result = await runner(["gh", "issue", "view", target, "--json", "title,body,url,labels"]);
    if (result.exitCode !== 0) throw new IntakeError(`gh issue view ${target} failed: ${result.stderr.trim()}`);
    const view = JSON.parse(result.stdout) as IssueView;
    const labels = view.labels.map((label) => label.name);
    return {
      source: { title: view.title, externalRef: view.url || target, externalContains: `${owner}/${repo}/issues/${number}`, text: view.body ?? "" },
      inferred: labels.includes("bug") ? "bug" : labels.includes("ready-for-agent") ? "spec" : "ticket",
      repos: [`${owner}/${repo}`],
    };
  }
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    const file = path.resolve(target);
    const text = fs.readFileSync(file, "utf8");
    const heading = text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
    return {
      source: { title: heading ?? path.basename(file), externalRef: `file:${file}`, externalContains: path.basename(file, path.extname(file)), text },
      inferred: "idea",
      repos: [],
    };
  }
  return { source: { title: target, externalRef: `text:${target}`, externalContains: target, text: target }, inferred: "idea", repos: [] };
}
