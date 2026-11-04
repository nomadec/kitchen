// The UI as the expeditor serves it (spec: UI, story 69): the bundled single-page app as static files,
// `/me` naming the owner the Pass view answers as, and the API the views read and write the space
// through, answered here by running `bd` over the space connection, the way every other call of
// Kitchen reaches the space. One loopback port, so the page and the API share an origin and a phone
// needs one tunnel; a bearer token on every API request, generated at each start into a file only the
// owner reads, so the browser holds the token and never the SQL credential. The routes keep the shape
// of bd serve's (`/v0/beads/...`), so the views are written against one contract; answering them here
// rather than through bd serve lets a local space, an embedded beads workspace, serve the same page.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseActor } from "../actor.ts";
import type { HostConfig } from "../config.ts";
import type { CommandRunner } from "../runner.ts";
import { openSpace, RefusedError, SpaceError } from "../space.ts";
import type { Bead, BeadFilter, JournalEvent, Space } from "../space.ts";

/** The loopback address the UI binds. */
export const LOOPBACK = "127.0.0.1";

export interface UiSpec {
  /** The directory holding index.html and app.js, as `npm run build` writes them. */
  uiDir: string;
  config: Pick<HostConfig, "owner" | "host" | "credential">;
  runner: CommandRunner;
  env: Record<string, string | undefined>;
  /** Where the bearer token is written at start, mode 0600, one line. */
  tokenFile: string;
  /** 0 takes an ephemeral port. */
  port: number;
}

export interface UiServer {
  url: string;
  tokenFile: string;
  close(): Promise<void>;
}

/** What `/me` answers: who the UI writes as, and where. No credential. */
export interface Me {
  owner: string;
  host: string;
}

/** A refusal as the API answers it, the shape bd serve gives one. */
interface Problem {
  code: string;
  detail: string;
  status: number;
  title: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

/** The largest body a request may carry: a word on a pass, never more. */
const MAX_BODY = 64 * 1024;

export function startUi(spec: UiSpec): Promise<UiServer> {
  const uiDir = path.resolve(spec.uiDir);
  const me: Me = { owner: spec.config.owner, host: spec.config.host };
  writeToken(spec.tokenFile);
  const api = apiRoutes(spec);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      reply(response, 200, "application/json", "{}");
      return;
    }
    if (url.pathname.startsWith("/v0/")) {
      void api(url, request, response);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      reply(response, 405, "text/plain; charset=utf-8", "GET only");
      return;
    }
    if (url.pathname === "/me") {
      reply(response, 200, "application/json", JSON.stringify(me));
      return;
    }
    const file = path.resolve(uiDir, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(`${uiDir}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      reply(response, 404, "text/plain; charset=utf-8", `not found: ${url.pathname}`);
      return;
    }
    reply(response, 200, CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream", fs.readFileSync(file));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(spec.port, LOOPBACK, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : spec.port;
      resolve({
        url: `http://${LOOPBACK}:${port}`,
        tokenFile: spec.tokenFile,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A fresh token, 32 random bytes as hex, one line, written whole and renamed into place. */
function writeToken(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, `${token}\n`, { mode: 0o600 });
  fs.renameSync(staging, file);
}

/** The lines of the token file, read at each request so a rewritten file is live at once; none when it is gone. */
function tokens(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

function reply(response: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function problem(response: http.ServerResponse, status: number, code: string, detail: string): void {
  const titles: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" };
  const body: Problem = { code, detail, status, title: titles[status] ?? "Error" };
  reply(response, status, "application/json", JSON.stringify(body));
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("the request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/** What `bd ready` and `bd list` narrow by, read from the query string as bd serve names the parameters. */
function filterOf(url: URL): BeadFilter {
  const filter: BeadFilter = {};
  const one = (name: string): string | undefined => {
    const value = url.searchParams.get(name);
    return value === null || value === "" ? undefined : value;
  };
  const type = one("type");
  const status = one("status");
  const assignee = one("assignee");
  const parent = one("parent");
  const labels = url.searchParams.getAll("label").filter((label) => label !== "");
  const limit = one("limit");
  if (type !== undefined) filter.type = type;
  if (status !== undefined) filter.status = status;
  if (assignee !== undefined) filter.assignee = assignee;
  if (parent !== undefined) filter.parent = parent;
  if (labels.length) filter.labels = labels;
  if (limit !== undefined && Number.isInteger(Number(limit)) && Number(limit) > 0) filter.limit = Number(limit);
  return filter;
}

type Route = (url: URL, request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

/**
 * The API: every route reads or writes the space through one bd call under an actor. Reads run as the
 * owner, the person the page serves; a close runs as the actor the body names, the human's name the
 * view sends, and the space wrapper's cooperative rules apply to it as to any other write.
 */
function apiRoutes(spec: UiSpec): Route {
  const space = (actor: string): Space => openSpace({ runner: spec.runner, env: spec.env, config: spec.config, actor: parseActor(actor) });
  const reads = space(spec.config.owner);
  const journal = journalReader(reads);
  const ISSUE = /^\/v0\/beads\/issues\/([^/:]+)$/;
  const CLOSE = /^\/v0\/beads\/issues\/([^/:]+):close$/;

  return async (url, request, response) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "" || !tokens(spec.tokenFile).includes(token)) {
      problem(response, 401, "unauthorized", "missing or invalid bearer token");
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/v0/beads/issues") {
        const items = await reads.list(filterOf(url));
        reply(response, 200, "application/json", JSON.stringify({ items }));
      } else if (request.method === "GET" && url.pathname === "/v0/beads/ready") {
        const items = await reads.ready(filterOf(url));
        reply(response, 200, "application/json", JSON.stringify({ items }));
      } else if (request.method === "GET" && ISSUE.test(url.pathname)) {
        const id = ISSUE.exec(url.pathname)?.[1] ?? "";
        let bead: Bead;
        try {
          bead = await reads.show(id);
        } catch (error) {
          if (error instanceof SpaceError) {
            problem(response, 404, "not_found", `no bead ${id}: ${error.result.stderr.trim() || error.result.stdout.trim()}`);
            return;
          }
          throw error;
        }
        reply(response, 200, "application/json", JSON.stringify(bead));
      } else if (request.method === "GET" && url.pathname === "/v0/beads/events") {
        const since = Number(url.searchParams.get("since") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "0");
        if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 0) {
          problem(response, 400, "invalid_argument", "`since` and `limit` must be whole numbers");
          return;
        }
        reply(response, 200, "application/json", JSON.stringify(await journal(since, limit)));
      } else if (request.method === "POST" && CLOSE.test(url.pathname)) {
        const id = CLOSE.exec(url.pathname)?.[1] ?? "";
        let body: { actor?: unknown; reason?: unknown };
        try {
          body = JSON.parse((await readBody(request)) || "{}") as { actor?: unknown; reason?: unknown };
        } catch (error) {
          problem(response, 400, "invalid_argument", `the body is not JSON: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (typeof body.actor !== "string" || body.actor.trim() === "") {
          problem(response, 400, "invalid_argument", "`actor` is required");
          return;
        }
        if (typeof body.reason !== "string" || body.reason.trim() === "") {
          problem(response, 400, "invalid_argument", "`reason` is required");
          return;
        }
        const writer = space(body.actor);
        const bead = await writer.show(id);
        if (bead.status === "closed") {
          problem(response, 409, "conflict", `${id} is already closed`);
          return;
        }
        await writer.close(bead, body.reason);
        reply(response, 200, "application/json", JSON.stringify({ id, status: "closed" }));
      } else {
        problem(response, 404, "not_found", `no route ${request.method} ${url.pathname}`);
      }
    } catch (error) {
      if (error instanceof RefusedError) problem(response, 403, "refused", error.message);
      else if (error instanceof SpaceError) problem(response, 409, "bd_refused", error.result.stderr.trim() || error.message);
      else problem(response, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * The journal route as the Activity view reads it: the head, the highest sequence number so far, and
 * the records after `since`, at most `limit` of them. bd tails the journal forward only, so the head is
 * learnt by reading what came after the last head seen: the whole journal on the first request of this
 * process, the new records on every later one.
 */
function journalReader(space: Space): (since: number, limit: number) => Promise<{ head: number; records: JournalEvent[] }> {
  let head = 0;
  return async (since, limit) => {
    for (const record of await space.events(head)) head = Math.max(head, record.seq);
    const records = limit === 0 ? await space.events(since) : await space.events(since, limit);
    return { head, records };
  };
}
