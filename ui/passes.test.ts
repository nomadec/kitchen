// The Pass view's data layer against a scripted fetch: open passes read from the API with their order
// and brief, the close posted with the word under the human actor, and the refusals before any request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ViewError } from "./client.ts";
import { passView } from "./passes.ts";
import { scriptedFetch } from "./scripted-fetch.ts";

const PASS = {
  id: "kitchen-33", title: "pass: approve the proposal", status: "open", issue_type: "gate", await_type: "human",
  description: "Ad-hoc gate blocking kitchen-34\n\nReason: The proposal is ready: ship, revise or stop?",
  labels: ["briefed"], parent: "kitchen-20", created_at: "2026-01-01T10:00:00Z", created_by: "sona/oven",
};
const TIMER = { id: "kitchen-35", title: "wait for the PR", status: "open", issue_type: "gate", await_type: "gh:pr", parent: "kitchen-20" };
const UNBRIEFED = { ...PASS, id: "kitchen-36", title: "no station for merge", labels: [], description: "no station holds sona-is/sona", parent: "kitchen-40" };
const ORDER = { id: "kitchen-20", title: "Stale cookie", status: "in_progress", issue_type: "epic", labels: ["loop"] };

const LIST = "/v0/beads/issues?type=gate&status=open&limit=0";

test("the Pass view lists every open pass from the API under the token, with its order's title and the brief, and leaves the typed waits out", async () => {
  const api = scriptedFetch([
    { method: "GET", url: LIST, status: 200, body: JSON.stringify({ has_more: false, items: [PASS, TIMER, UNBRIEFED] }) },
    { method: "GET", url: "/v0/beads/issues/kitchen-20", status: 200, body: JSON.stringify(ORDER) },
    { method: "GET", url: "/v0/beads/issues/kitchen-40", status: 404, body: '{"code":"not_found","detail":"no issue or wisp with that id"}' },
  ]);
  const view = passView({ fetch: api.fetch, token: "tok123", actor: "sona" });

  const passes = await view.list();

  assert.deepEqual(passes, [
    {
      id: "kitchen-33",
      title: "pass: approve the proposal",
      brief: "The proposal is ready: ship, revise or stop?",
      order: { id: "kitchen-20", title: "Stale cookie" },
      laidBy: "sona/oven",
      laidAt: "2026-01-01T10:00:00Z",
    },
    {
      id: "kitchen-36",
      title: "no station for merge",
      brief: "no station holds sona-is/sona",
      order: { id: "kitchen-40", title: undefined },
      laidBy: "sona/oven",
      laidAt: "2026-01-01T10:00:00Z",
    },
  ]);
  assert.deepEqual(api.requests.map((r) => [r.method, r.url, r.headers.authorization]), [
    ["GET", LIST, "Bearer tok123"],
    ["GET", "/v0/beads/issues/kitchen-20", "Bearer tok123"],
    ["GET", "/v0/beads/issues/kitchen-40", "Bearer tok123"],
  ]);
});

test("an answer closes the pass through the API with the word as the reason under the human actor, and nothing else", async () => {
  const api = scriptedFetch([
    { method: "POST", url: "/v0/beads/issues/kitchen-33:close", status: 200, body: JSON.stringify({ already_closed: false, issue: { ...PASS, status: "closed", close_reason: "ship" } }) },
  ]);
  const view = passView({ fetch: api.fetch, token: "tok123", actor: "sona" });

  await view.answer({ id: "kitchen-33" }, "  ship  ");

  assert.deepEqual(api.requests, [{
    method: "POST",
    url: "/v0/beads/issues/kitchen-33:close",
    headers: { authorization: "Bearer tok123", "content-type": "application/json" },
    body: JSON.stringify({ actor: "sona", reason: "ship" }),
  }]);
});

test("a station actor, and the expeditor, may not close a pass through the UI: refused before any request, naming the rule", async () => {
  for (const actor of ["sona/oven", "sona/expeditor"]) {
    const api = scriptedFetch([]);
    const view = passView({ fetch: api.fetch, token: "tok123", actor });
    await assert.rejects(
      () => view.answer({ id: "kitchen-33" }, "ship"),
      (error: unknown) =>
        error instanceof ViewError &&
        error.message === `${actor} may not close the pass kitchen-33: a pass closes only under a person's name (a cooperative rule, not a security boundary: docs/trust-model.md)`,
    );
    assert.equal(api.requests.length, 0);
  }
});

test("an empty word is refused before any request; a refused token and a the API refusal are reported with their detail", async () => {
  const empty = scriptedFetch([]);
  await assert.rejects(() => passView({ fetch: empty.fetch, token: "tok123", actor: "sona" }).answer({ id: "kitchen-33" }, "   "), /the word is empty/);
  assert.equal(empty.requests.length, 0);

  const refused = scriptedFetch([
    { method: "GET", url: LIST, status: 401, body: '{"code":"unauthenticated","detail":"missing or invalid bearer token"}' },
    { method: "POST", url: "/v0/beads/issues/kitchen-33:close", status: 409, body: '{"code":"conflict","detail":"kitchen-33 is already closed"}' },
  ]);
  const view = passView({ fetch: refused.fetch, token: "stale", actor: "sona" });
  await assert.rejects(() => view.list(), (error: unknown) => error instanceof ViewError && error.message === "the token was refused: missing or invalid bearer token" && error.status === 401);
  await assert.rejects(() => view.answer({ id: "kitchen-33" }, "ship"), (error: unknown) => error instanceof ViewError && error.message === "the space refused the close of kitchen-33: kitchen-33 is already closed" && error.status === 409);
});
