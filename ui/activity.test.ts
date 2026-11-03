// The Activity view's data layer against a scripted fetch: the latest records of the events journal,
// newest first, each with when, who, what and to which bead, read from bd serve's events route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activityView } from "./activity.ts";
import { scriptedFetch } from "./scripted-fetch.ts";

const HEAD = "/v0/beads/events?since=0&limit=1";
const COOKIE = { id: "kitchen-20", title: "Stale cookie", status: "open", issue_type: "epic", labels: ["loop"] };
const BUILD = { id: "kitchen-20.2", title: "build", status: "in_progress", issue_type: "task", assignee: "sona/oven" };
const PASS = { id: "kitchen-33", title: "pass: approve the proposal", status: "closed", issue_type: "gate", await_type: "human", close_reason: "ship" };

test("the Activity view reads the journal's head, then the latest records up to its count, and lists them newest first with when, who, what and the bead", async () => {
  const api = scriptedFetch([
    { method: "GET", url: HEAD, status: 200, body: JSON.stringify({ head: 11, records: [{ seq: 1, ts: "2026-01-01T09:00:00Z", op: "create", issue_id: "kitchen-1", actor: "sona", issue: { id: "kitchen-1", title: "umka/grill" } }] }) },
    {
      method: "GET",
      url: "/v0/beads/events?since=8&limit=3",
      status: 200,
      body: JSON.stringify({
        head: 11,
        records: [
          { seq: 9, ts: "2026-01-01T10:00:00Z", op: "dep_add", issue_id: "kitchen-20.2", actor: "sona/expeditor", issue: BUILD, dep: { kind: "parent-child", target: "kitchen-20", metadata: "{}" } },
          { seq: 10, ts: "2026-01-01T10:05:00Z", op: "update", issue_id: "kitchen-20.2", actor: "sona/oven", issue: BUILD },
          { seq: 11, ts: "2026-01-01T10:30:00Z", op: "close", issue_id: "kitchen-33", actor: "sona", issue: PASS },
        ],
      }),
    },
  ]);
  const view = activityView({ fetch: api.fetch, token: "tok123" });

  const events = await view.latest(3);

  assert.deepEqual(events, [
    { seq: 11, at: "2026-01-01T10:30:00Z", actor: "sona", op: "close", bead: "kitchen-33", title: "pass: approve the proposal", detail: "ship" },
    { seq: 10, at: "2026-01-01T10:05:00Z", actor: "sona/oven", op: "update", bead: "kitchen-20.2", title: "build", detail: "in_progress, at sona/oven" },
    { seq: 9, at: "2026-01-01T10:00:00Z", actor: "sona/expeditor", op: "dep_add", bead: "kitchen-20.2", title: "build", detail: "parent-child kitchen-20" },
  ]);
  assert.deepEqual(api.requests.map((r) => [r.url, r.headers.authorization]), [
    [HEAD, "Bearer tok123"],
    ["/v0/beads/events?since=8&limit=3", "Bearer tok123"],
  ]);
});

test("a journal shorter than the count is read from its beginning, and an empty one answers no events after one request", async () => {
  const short = scriptedFetch([
    { method: "GET", url: HEAD, status: 200, body: JSON.stringify({ head: 2, records: [{ seq: 1, ts: "2026-01-01T09:00:00Z", op: "create", issue_id: "kitchen-20", actor: "sona", issue: COOKIE }] }) },
    {
      method: "GET",
      url: "/v0/beads/events?since=0&limit=50",
      status: 200,
      body: JSON.stringify({
        head: 2,
        records: [
          { seq: 1, ts: "2026-01-01T09:00:00Z", op: "create", issue_id: "kitchen-20", actor: "sona", issue: COOKIE },
          { seq: 2, ts: "2026-01-01T09:00:01Z", op: "create", issue_id: "kitchen-20.1", actor: "sona/expeditor", issue: { id: "kitchen-20.1", title: "grill", status: "open", issue_type: "task" } },
        ],
      }),
    },
  ]);
  assert.deepEqual(
    (await activityView({ fetch: short.fetch, token: "tok123" }).latest()).map((e) => [e.seq, e.bead]),
    [[2, "kitchen-20.1"], [1, "kitchen-20"]],
  );

  const empty = scriptedFetch([{ method: "GET", url: HEAD, status: 200, body: JSON.stringify({ head: 0, records: [] }) }]);
  assert.deepEqual(await activityView({ fetch: empty.fetch, token: "tok123" }).latest(), []);
  assert.equal(empty.requests.length, 1);
});

test("a journal bd serve does not keep is reported with its detail, and a refused token with its status", async () => {
  const off = scriptedFetch([{ method: "GET", url: HEAD, status: 400, body: '{"code":"invalid_argument","detail":"the durable events journal is not enabled on this workspace; set `events-journal true` and restart the server"}' }]);
  await assert.rejects(
    () => activityView({ fetch: off.fetch, token: "tok123" }).latest(),
    (error: unknown) => error instanceof Error && error.message === "bd serve refused the events journal: the durable events journal is not enabled on this workspace; set `events-journal true` and restart the server",
  );
  const refused = scriptedFetch([{ method: "GET", url: HEAD, status: 401, body: '{"code":"unauthenticated","detail":"missing or invalid bearer token"}' }]);
  await assert.rejects(() => activityView({ fetch: refused.fetch, token: "stale" }).latest(), (error: unknown) => error instanceof Error && (error as { status?: number }).status === 401);
});
