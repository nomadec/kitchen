// The Stations view's data layer against a scripted fetch: every registered station with its owner,
// host, what it offers, its cap against the turns it runs, and at an attended station the phases the
// expeditor marked waiting with the exact `kitchen turn <phase>` command that starts each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stationsView } from "./stations.ts";
import { scriptedFetch } from "./scripted-fetch.ts";

const STATIONS = "/v0/beads/issues?type=station&limit=0";
const ORDERS = "/v0/beads/issues?type=epic&label=loop&limit=0";
const running = (station: string) => `/v0/beads/issues?assignee=${encodeURIComponent(station)}&status=in_progress&limit=0`;
const ready = (station: string) => `/v0/beads/ready?assignee=${encodeURIComponent(station)}&limit=0`;

const launch = (cap: number) =>
  `\`\`\`json\n${JSON.stringify({ provider: "claude", models: ["opus"], auth: "subscription", plugins: [], skills: [], repositories: [{ slug: "sona-is/sona", path: "/home/sona/sona" }], worktrees: "per-order", cap, budget: { usd: 5, effort: "high" }, timeout: "45m", secrets: [] })}\n\`\`\``;
const OVEN = { id: "kitchen-3", title: "sona/oven", status: "open", issue_type: "station", labels: ["cap:2", "host:sona-laptop", "owner:sona"], notes: `offers: builds and reviews sona\n\n${launch(2)}` };
const GRILL = { id: "kitchen-4", title: "sona/grill", status: "open", issue_type: "station", labels: ["attended", "cap:1", "host:sona-laptop", "owner:sona"], notes: `offers: a conversation with Sona at the laptop\n\n${launch(1)}` };
const DESK = { id: "kitchen-5", title: "raffy/desk", status: "open", issue_type: "station", labels: ["cap:1", "host:raffy-box", "owner:raffy"], notes: `offers: builds on Raffy's box\n\n${launch(1)}` };

const COOKIE = { id: "kitchen-20", title: "Stale cookie", status: "in_progress", issue_type: "epic", labels: ["loop"], notes: "repos: sona-is/sona\nrecipe: umka rev:ab12cd\nclass: idea" };
const BUILD = { id: "kitchen-20.2", title: "build", status: "in_progress", issue_type: "task", parent: "kitchen-20", assignee: "sona/oven", labels: ["phase:build", "station:sona/oven"] };
const REVIEW = { id: "kitchen-20.3", title: "review", status: "open", issue_type: "task", parent: "kitchen-20", assignee: "sona/grill", labels: ["phase:review", "station:sona/grill", "waiting"] };
// Ready, but not yet marked waiting by the expeditor (held by another turn, or over the cap): no command yet.
const HELD = { id: "kitchen-70.1", title: "build", status: "open", issue_type: "task", parent: "kitchen-70", assignee: "sona/grill", labels: ["phase:build", "station:sona/grill"] };
const ORPHAN = { id: "kitchen-60.1", title: "grill", status: "open", issue_type: "task", parent: "kitchen-60", assignee: "sona/grill", labels: ["phase:grill", "station:sona/grill", "waiting"] };

test("the Stations view lists every station under the token with its fields, the turns it runs against its cap, and the phases marked waiting at an attended station with the kitchen turn command for each", async () => {
  const api = scriptedFetch([
    { method: "GET", url: STATIONS, status: 200, body: JSON.stringify({ has_more: false, items: [OVEN, GRILL, DESK] }) },
    { method: "GET", url: ORDERS, status: 200, body: JSON.stringify({ has_more: false, items: [COOKIE] }) },
    // The order a station holds is assigned to it too; only the phases are turns.
    { method: "GET", url: running("sona/oven"), status: 200, body: JSON.stringify({ has_more: false, items: [COOKIE, BUILD] }) },
    { method: "GET", url: running("sona/grill"), status: 200, body: JSON.stringify({ has_more: false, items: [] }) },
    { method: "GET", url: ready("sona/grill"), status: 200, body: JSON.stringify({ has_more: false, items: [REVIEW, HELD, ORPHAN] }) },
    { method: "GET", url: running("raffy/desk"), status: 200, body: JSON.stringify({ has_more: false, items: [] }) },
  ]);
  const view = stationsView({ fetch: api.fetch, token: "tok123" });

  const stations = await view.list();

  assert.deepEqual(stations, [
    {
      id: "kitchen-3",
      title: "sona/oven",
      owner: "sona",
      host: "sona-laptop",
      attended: false,
      offers: "builds and reviews sona",
      cap: 2,
      running: [{ id: "kitchen-20.2", title: "build", order: "kitchen-20 (Stale cookie)" }],
      waiting: [],
    },
    {
      id: "kitchen-4",
      title: "sona/grill",
      owner: "sona",
      host: "sona-laptop",
      attended: true,
      offers: "a conversation with Sona at the laptop",
      cap: 1,
      running: [],
      waiting: [
        { id: "kitchen-20.3", title: "review", order: "kitchen-20 (Stale cookie)", command: "kitchen turn kitchen-20.3" },
        { id: "kitchen-60.1", title: "grill", order: "kitchen-60", command: "kitchen turn kitchen-60.1" },
      ],
    },
    {
      id: "kitchen-5",
      title: "raffy/desk",
      owner: "raffy",
      host: "raffy-box",
      attended: false,
      offers: "builds on Raffy's box",
      cap: 1,
      running: [],
      waiting: [],
    },
  ]);
  assert.deepEqual(api.requests.map((r) => [r.url, r.headers.authorization]), [
    [STATIONS, "Bearer tok123"],
    [ORDERS, "Bearer tok123"],
    [running("sona/oven"), "Bearer tok123"],
    [running("sona/grill"), "Bearer tok123"],
    [ready("sona/grill"), "Bearer tok123"],
    [running("raffy/desk"), "Bearer tok123"],
  ]);
});

test("a station bead that does not parse names what it lacks, and a refused token stops the view at the first list", async () => {
  const broken = scriptedFetch([
    { method: "GET", url: STATIONS, status: 200, body: JSON.stringify({ has_more: false, items: [{ ...OVEN, labels: ["host:sona-laptop", "owner:sona"] }] }) },
  ]);
  await assert.rejects(() => stationsView({ fetch: broken.fetch, token: "tok123" }).list(), (error: unknown) => error instanceof Error && error.message === "kitchen-3 carries no cap: label");

  const refused = scriptedFetch([{ method: "GET", url: STATIONS, status: 401, body: '{"code":"unauthenticated","detail":"missing or invalid bearer token"}' }]);
  await assert.rejects(() => stationsView({ fetch: refused.fetch, token: "stale" }).list(), (error: unknown) => error instanceof Error && error.name === "ViewError" && (error as { status?: number }).status === 401);
  assert.equal(refused.requests.length, 1);
});
