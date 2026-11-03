// The UI server at its HTTP seam, the one a browser or a phone reaches: the bundled files, `/me`, and
// every `/v0/...` request passed through to a server standing in for bd serve, token and body intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startUi } from "./ui.ts";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  host: string | undefined;
  body: string;
}

/** A server standing in for bd serve: records what reaches it and answers as told. */
function fakeBdServe(t: { after(fn: () => void): void }, answer: { status: number; body: string }): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, host: request.headers.host, body });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  t.after(close);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, seen, close });
    });
  });
}

async function ui(t: { after(fn: () => void): void }, api: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-ui-"));
  const uiDir = path.join(root, "ui");
  fs.mkdirSync(uiDir);
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>Kitchen</title><script type=module src=app.js></script>");
  fs.writeFileSync(path.join(uiDir, "app.js"), "console.log('pass view')");
  fs.writeFileSync(path.join(root, "outside.txt"), "not served");
  const server = await startUi({ uiDir, owner: "sona", host: "sona-laptop", port: 0, api });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return server;
}

test("the UI server serves the bundled page and script from its directory, names the owner at /me, and answers nothing outside the directory", async (t) => {
  const api = await fakeBdServe(t, { status: 200, body: "{}" });
  const server = await ui(t, api.url);
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
  assert.equal(api.seen.length, 0, "none of this reached bd serve");
});

test("a /v0 request is passed to bd serve with its method, path, bearer token and body, and bd serve's status and body come back as they are", async (t) => {
  const api = await fakeBdServe(t, { status: 400, body: '{"code":"invalid_argument","detail":"`actor` is required"}' });
  const server = await ui(t, api.url);

  const answer = await fetch(`${server.url}/v0/beads/issues/kitchen-42:close`, {
    method: "POST",
    headers: { authorization: "Bearer tok123", "content-type": "application/json" },
    body: '{"reason":"ship"}',
  });

  assert.equal(answer.status, 400);
  assert.equal(answer.headers.get("content-type"), "application/json");
  assert.deepEqual(await answer.json(), { code: "invalid_argument", detail: "`actor` is required" });
  assert.deepEqual(api.seen, [{
    method: "POST",
    url: "/v0/beads/issues/kitchen-42:close",
    authorization: "Bearer tok123",
    // bd serve answers only to loopback spellings of Host: the proxy's own, never the browser's.
    host: new URL(api.url).host,
    body: '{"reason":"ship"}',
  }]);

  const list = await fetch(`${server.url}/v0/beads/issues?type=gate&status=open`, { headers: { authorization: "Bearer tok123" } });
  assert.equal(list.status, 400, "every status comes back as bd serve gave it");
  assert.equal(api.seen[1]?.url, "/v0/beads/issues?type=gate&status=open");
  assert.equal(api.seen[1]?.method, "GET");
});

test("when bd serve is not answering, a /v0 request is a 502 naming it, and the page still loads", async (t) => {
  const gone = await fakeBdServe(t, { status: 200, body: "{}" });
  await gone.close();
  const server = await ui(t, gone.url);

  const answer = await fetch(`${server.url}/v0/beads/issues`, { headers: { authorization: "Bearer tok123" } });

  assert.equal(answer.status, 502);
  assert.match(((await answer.json()) as { detail: string }).detail, new RegExp(`bd serve at ${gone.url} did not answer`));
  assert.equal((await fetch(`${server.url}/`)).status, 200);
});
