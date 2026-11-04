// The UI server at its HTTP seam, the one a browser or a phone reaches: the bundled files, `/me`, and
// the API answered by bd calls over the space connection under the token the server wrote at start.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeRunner, LOCAL_HOST_CONFIG, TEST_HOST_CONFIG } from "../testing/index.ts";
import type { ScriptedAnswer } from "../testing/index.ts";
import { startUi } from "./ui.ts";

const CONFIG = TEST_HOST_CONFIG;

async function ui(t: { after(fn: () => void): void }, table: readonly ScriptedAnswer[], config = CONFIG) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-ui-"));
  const uiDir = path.join(root, "ui");
  fs.mkdirSync(uiDir);
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>Kitchen</title><script type=module src=app.js></script>");
  fs.writeFileSync(path.join(uiDir, "app.js"), "console.log('pass view')");
  fs.writeFileSync(path.join(root, "outside.txt"), "not served");
  const tokenFile = path.join(root, "state", "serve.token");
  const runner = fakeRunner(table);
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, ".config") };
  const server = await startUi({ uiDir, config, runner, env, tokenFile, port: 0 });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const auth = { authorization: `Bearer ${token}` };
  const connection = { cwd: path.join(root, ".config", "kitchen", "space"), env: config.credential === undefined ? {} : { BEADS_CREDENTIALS_FILE: config.credential } };
  return { server, runner, tokenFile, token, auth, connection, root };
}

test("the UI server serves the bundled page and script from its directory, names the owner at /me, and answers nothing outside the directory", async (t) => {
  const { server, runner } = await ui(t, []);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, "loopback only");

  const page = await fetch(`${server.url}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await page.text(), /<title>Kitchen<\/title>/);

  const script = await fetch(`${server.url}/app.js`);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await script.text(), "console.log('pass view')");

  const me = await fetch(`${server.url}/me`);
  assert.deepEqual(await me.json(), { owner: "sona", host: "sona-laptop" });

  assert.equal((await fetch(`${server.url}/missing.js`)).status, 404);
  assert.equal((await fetch(`${server.url}/%2e%2e/outside.txt`)).status, 404);
  assert.equal((await fetch(`${server.url}/me`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200, "liveness needs no token");
  assert.deepEqual(runner.calls, [], "none of this reached bd");
});

test("the token is written at start, mode 0600, one line; a request without it, or with another, is a 401 before any bd call, and a line added to the file is live at once", async (t) => {
  const { server, runner, tokenFile, token, auth } = await ui(t, [{ command: "bd", args: ["--actor", "sona", "list"], stdout: "[]" }]);

  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(tokenFile, "utf8"), /^[0-9a-f]{64}\n$/, "one token per line");

  const bare = await fetch(`${server.url}/v0/beads/issues`);
  assert.equal(bare.status, 401);
  assert.deepEqual(await bare.json(), { code: "unauthorized", detail: "missing or invalid bearer token", status: 401, title: "Unauthorized" });
  assert.equal((await fetch(`${server.url}/v0/beads/issues`, { headers: { authorization: "Bearer not-it" } })).status, 401);
  assert.deepEqual(runner.calls, [], "a refused token reaches no bd call");

  assert.equal((await fetch(`${server.url}/v0/beads/issues`, { headers: auth })).status, 200);
  fs.appendFileSync(tokenFile, "second-token\n");
  assert.equal((await fetch(`${server.url}/v0/beads/issues`, { headers: { authorization: "Bearer second-token" } })).status, 200, "the file is re-read at each request");
  assert.equal(runner.calls.length, 2);
  assert.notEqual(token, "second-token");
});

test("the issues and ready routes answer bd list and bd ready as the owner over the space connection, the query narrowing the call as bd serve names it", async (t) => {
  const bead = { id: "kitchen-7", title: "approve: smoke", status: "open", issue_type: "gate", await_type: "human" };
  const { server, runner, auth, connection } = await ui(t, [
    { command: "bd", args: ["--actor", "sona", "list"], stdout: JSON.stringify([bead]) },
    { command: "bd", args: ["--actor", "sona", "ready"], stdout: JSON.stringify([{ ...bead, id: "kitchen-8" }]) },
  ]);

  const list = await fetch(`${server.url}/v0/beads/issues?type=gate&status=open&limit=0`, { headers: auth });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { items: [bead] });
  assert.deepEqual(runner.calls[0], { argv: ["bd", "--actor", "sona", "list", "--type", "gate", "--status", "open", "--limit", "0", "--json"], ...connection });

  const closed = await fetch(`${server.url}/v0/beads/issues?type=epic&label=loop&status=closed&limit=20`, { headers: auth });
  assert.equal(closed.status, 200);
  assert.deepEqual(runner.calls[1]?.argv, ["bd", "--actor", "sona", "list", "--type", "epic", "--label", "loop", "--status", "closed", "--limit", "20", "--json"], "a limit above 0 is passed on");

  const ready = await fetch(`${server.url}/v0/beads/ready?assignee=${encodeURIComponent("sona/grill")}&limit=0`, { headers: auth });
  assert.deepEqual(await ready.json(), { items: [{ ...bead, id: "kitchen-8" }] });
  assert.deepEqual(runner.calls[2]?.argv, ["bd", "--actor", "sona", "ready", "--assignee", "sona/grill", "--limit", "0", "--json"]);

  const children = await fetch(`${server.url}/v0/beads/issues?parent=kitchen-1&limit=0`, { headers: auth });
  assert.equal(children.status, 200);
  assert.deepEqual(runner.calls[3]?.argv, ["bd", "--actor", "sona", "list", "--parent", "kitchen-1", "--limit", "0", "--json"]);
});

test("one issue is bd show; a bead bd does not find is a 404 with bd's words, and a route that is not there a 404 too", async (t) => {
  const order = { id: "kitchen-1", title: "Say hello", status: "open", issue_type: "epic" };
  const { server, runner, auth } = await ui(t, [
    { command: "bd", args: ["--actor", "sona", "show", "kitchen-1"], stdout: JSON.stringify([order]) },
    { command: "bd", args: ["--actor", "sona", "show", "kitchen-9"], exitCode: 1, stderr: "Error: no issues found matching the provided IDs\n" },
  ]);

  const one = await fetch(`${server.url}/v0/beads/issues/kitchen-1`, { headers: auth });
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), order);
  assert.deepEqual(runner.calls[0]?.argv, ["bd", "--actor", "sona", "show", "kitchen-1", "--json"]);

  const gone = await fetch(`${server.url}/v0/beads/issues/kitchen-9`, { headers: auth });
  assert.equal(gone.status, 404);
  assert.match(((await gone.json()) as { detail: string }).detail, /no bead kitchen-9: Error: no issues found/);

  assert.equal((await fetch(`${server.url}/v0/beads/nothing`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${server.url}/v0/beads/issues`, { method: "DELETE", headers: auth })).status, 404);
});

test("a close posts bd close under the actor the body names with the word as the reason; a missing actor or word is a 400, a closed pass a 409, and a station actor is refused by the space wrapper as a 403", async (t) => {
  const pass = { id: "kitchen-33", title: "approve: smoke", status: "open", issue_type: "gate", await_type: "human" };
  const { server, runner, auth, connection } = await ui(t, [
    { command: "bd", args: ["--actor", "sona", "show", "kitchen-33"], stdout: JSON.stringify([pass]) },
    { command: "bd", args: ["--actor", "sona", "close", "kitchen-33"], stdout: "[]" },
    { command: "bd", args: ["--actor", "sona", "show", "kitchen-34"], stdout: JSON.stringify([{ ...pass, id: "kitchen-34", status: "closed" }]) },
    { command: "bd", args: ["--actor", "sona/oven", "show", "kitchen-33"], stdout: JSON.stringify([pass]) },
  ]);
  const post = (path: string, body: unknown, headers = auth) => fetch(`${server.url}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

  const closed = await post("/v0/beads/issues/kitchen-33:close", { actor: "sona", reason: "ship" });
  assert.equal(closed.status, 200, await closed.text());
  assert.deepEqual(runner.calls.map((c) => c.argv), [
    ["bd", "--actor", "sona", "show", "kitchen-33", "--json"],
    ["bd", "--actor", "sona", "close", "kitchen-33", "--reason", "ship", "--json"],
  ]);
  assert.deepEqual({ cwd: runner.calls[1]?.cwd, env: runner.calls[1]?.env }, connection, "the close runs over the space connection");

  const noActor = await post("/v0/beads/issues/kitchen-33:close", { reason: "ship" });
  assert.equal(noActor.status, 400);
  assert.deepEqual(await noActor.json(), { code: "invalid_argument", detail: "`actor` is required", status: 400, title: "Bad Request" });
  assert.equal((await post("/v0/beads/issues/kitchen-33:close", { actor: "sona", reason: " " })).status, 400);
  assert.equal((await fetch(`${server.url}/v0/beads/issues/kitchen-33:close`, { method: "POST", headers: auth, body: "{not json" })).status, 400);

  const again = await post("/v0/beads/issues/kitchen-34:close", { actor: "sona", reason: "ship" });
  assert.equal(again.status, 409);
  assert.match(((await again.json()) as { detail: string }).detail, /kitchen-34 is already closed/);

  const station = await post("/v0/beads/issues/kitchen-33:close", { actor: "sona/oven", reason: "ship" });
  assert.equal(station.status, 403);
  assert.match(((await station.json()) as { detail: string }).detail, /sona\/oven may not close the pass kitchen-33/);
  assert.deepEqual(runner.calls.slice(2).map((c) => c.argv[3]), ["show", "show"], "the conflict and the refusal read the bead and issued no bd close");
});

test("the events route answers the journal's head and the records after since, the head learnt from the records read so far", async (t) => {
  const record = (seq: number) => JSON.stringify({ seq, ts: "2026-01-01T00:00:00Z", op: "create", issue_id: `kitchen-${seq}`, actor: "sona", issue: { title: `bead ${seq}` } });
  const { server, runner, auth } = await ui(t, [
    { command: "bd", args: ["--actor", "sona", "events", "tail", "--since", "0", "--limit", "1"], stdout: `${record(1)}\n` },
    { command: "bd", args: ["--actor", "sona", "events", "tail", "--since", "0"], stdout: `${record(1)}\n${record(2)}\n${record(3)}\n` },
    { command: "bd", args: ["--actor", "sona", "events", "tail", "--since", "3"], stdout: "" },
    { command: "bd", args: ["--actor", "sona", "events", "tail", "--since", "1", "--limit", "2"], stdout: `${record(2)}\n${record(3)}\n` },
  ]);

  const head = await fetch(`${server.url}/v0/beads/events?since=0&limit=1`, { headers: auth });
  assert.equal(head.status, 200);
  assert.deepEqual(await head.json(), { head: 3, records: [JSON.parse(record(1))] });
  assert.deepEqual(runner.calls.map((c) => c.argv.slice(3)), [["events", "tail", "--since", "0"], ["events", "tail", "--since", "0", "--limit", "1"]], "the whole journal once for the head, then the window asked for");

  const window = await fetch(`${server.url}/v0/beads/events?since=1&limit=2`, { headers: auth });
  assert.deepEqual(await window.json(), { head: 3, records: [JSON.parse(record(2)), JSON.parse(record(3))] });
  assert.deepEqual(runner.calls[2]?.argv.slice(3), ["events", "tail", "--since", "3"], "later requests read only what came after the head seen");

  assert.equal((await fetch(`${server.url}/v0/beads/events?since=x`, { headers: auth })).status, 400);
});

test("a host with a local space serves the same API with no credential in any bd call's environment", async (t) => {
  const { server, runner, auth, connection } = await ui(t, [{ command: "bd", args: ["--actor", "sona", "list"], stdout: "[]" }], LOCAL_HOST_CONFIG);

  assert.equal((await fetch(`${server.url}/v0/beads/issues?type=station`, { headers: auth })).status, 200);
  assert.deepEqual({ cwd: runner.calls[0]?.cwd, env: runner.calls[0]?.env }, connection);
  assert.deepEqual(runner.calls[0]?.env, {});
});
