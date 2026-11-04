// The Orders view's data layer against a scripted fetch: every order read from the API, closed ones
// too (the twenty closed last), grouped by status in a fixed order, each with its class, the recipe revision it pinned and the
// phases it is at now, read from its open children.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ordersView } from "./orders.ts";
import { scriptedFetch } from "./scripted-fetch.ts";

const LIST = "/v0/beads/issues?type=epic&label=loop&limit=0";
const CLOSED = "/v0/beads/issues?type=epic&label=loop&status=closed&limit=20";
const children = (id: string) => `/v0/beads/issues?parent=${id}&limit=0`;

const COOKIE = { id: "kitchen-20", title: "Stale cookie", status: "in_progress", issue_type: "epic", labels: ["loop"], notes: "repos: sona-is/sona\nrecipe: umka rev:ab12cd\nclass: idea", external_ref: "https://github.com/sona-is/sona/issues/7" };
const CRUMBS = { id: "kitchen-40", title: "Crumbs on the floor", status: "open", issue_type: "epic", labels: ["loop"], notes: "repos: sona-is/sona\nrecipe: umka rev:ab12cd, bakery rev:9f9f9f\nclass: bug" };
const SWEPT = { id: "kitchen-10", title: "Swept already", status: "closed", issue_type: "epic", labels: ["loop"], notes: "repos: sona-is/sona\nrecipe: umka rev:000000\nclass: ticket" };
const UNNOTED = { id: "kitchen-50", title: "An order by hand", status: "open", issue_type: "epic", labels: ["loop"] };

const BUILD = { id: "kitchen-20.2", title: "build", status: "in_progress", issue_type: "task", parent: "kitchen-20", assignee: "sona/oven", labels: ["phase:build", "station:sona/oven"] };
const REVIEW = { id: "kitchen-20.3", title: "review", status: "open", issue_type: "task", parent: "kitchen-20", assignee: "sona/grill", labels: ["phase:review", "station:sona/grill", "waiting"] };
const PASS = { id: "kitchen-33", title: "pass: approve", status: "open", issue_type: "gate", await_type: "human", parent: "kitchen-20" };
const GRILL = { id: "kitchen-40.1", title: "grill", status: "open", issue_type: "task", parent: "kitchen-40", assignee: "sona/grill", labels: ["phase:grill", "station:sona/grill"] };

test("the Orders view lists every open order and the orders closed last under the token, grouped by status, with its class, pinned revision and the phases it is at, read from its open children", async () => {
  const api = scriptedFetch([
    { method: "GET", url: LIST, status: 200, body: JSON.stringify({ has_more: false, items: [CRUMBS, COOKIE, UNNOTED] }) },
    { method: "GET", url: CLOSED, status: 200, body: JSON.stringify({ has_more: false, items: [SWEPT] }) },
    { method: "GET", url: children("kitchen-20"), status: 200, body: JSON.stringify({ has_more: false, items: [REVIEW, PASS, BUILD] }) },
    { method: "GET", url: children("kitchen-40"), status: 200, body: JSON.stringify({ has_more: false, items: [GRILL] }) },
    { method: "GET", url: children("kitchen-50"), status: 200, body: JSON.stringify({ has_more: false, items: [] }) },
  ]);
  const view = ordersView({ fetch: api.fetch, token: "tok123" });

  const groups = await view.list();

  assert.deepEqual(groups, [
    {
      status: "in_progress",
      orders: [
        {
          id: "kitchen-20",
          title: "Stale cookie",
          status: "in_progress",
          class: "idea",
          recipe: "umka",
          revision: "rev:ab12cd",
          externalRef: "https://github.com/sona-is/sona/issues/7",
          phases: [
            { id: "kitchen-20.2", slug: "build", state: "in progress", station: "sona/oven" },
            { id: "kitchen-20.3", slug: "review", state: "waiting", station: "sona/grill" },
          ],
        },
      ],
    },
    {
      status: "open",
      orders: [
        { id: "kitchen-40", title: "Crumbs on the floor", status: "open", class: "bug", recipe: "umka", revision: "rev:ab12cd", externalRef: undefined, phases: [{ id: "kitchen-40.1", slug: "grill", state: "laid", station: "sona/grill" }] },
        { id: "kitchen-50", title: "An order by hand", status: "open", class: undefined, recipe: undefined, revision: undefined, externalRef: undefined, phases: [] },
      ],
    },
    {
      status: "closed",
      orders: [{ id: "kitchen-10", title: "Swept already", status: "closed", class: "ticket", recipe: "umka", revision: "rev:000000", externalRef: undefined, phases: [] }],
    },
  ]);
  assert.deepEqual(api.requests.map((r) => [r.method, r.url, r.headers.authorization]), [
    ["GET", LIST, "Bearer tok123"],
    ["GET", CLOSED, "Bearer tok123"],
    ["GET", children("kitchen-40"), "Bearer tok123"],
    ["GET", children("kitchen-20"), "Bearer tok123"],
    ["GET", children("kitchen-50"), "Bearer tok123"],
  ]);
});

test("a refused token stops the Orders view at the list, with the API's detail and the status", async () => {
  const api = scriptedFetch([{ method: "GET", url: LIST, status: 401, body: '{"code":"unauthenticated","detail":"missing or invalid bearer token"}' }]);
  const view = ordersView({ fetch: api.fetch, token: "stale" });
  await assert.rejects(
    () => view.list(),
    (error: unknown) => error instanceof Error && error.name === "ViewError" && error.message === "the token was refused: missing or invalid bearer token" && (error as { status?: number }).status === 401,
  );
  assert.equal(api.requests.length, 1);
});
