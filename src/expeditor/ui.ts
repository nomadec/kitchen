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
import { JournalTruncatedError, openSpace, RefusedError, SpaceError } from "../space.ts";
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

const TITLES: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" };

function problem(response: http.ServerResponse, status: number, code: string, detail: string): void {
  const body: Problem = { code, detail, status, title: TITLES[status] ?? "Error" };
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

/** A refusal the route answers as a 400, raised while reading the request. */
class BadRequest extends Error {}

/**
 * A query parameter that is a whole number when given: the number, undefined when absent or empty, a
 * BadRequest otherwise. One rule for `limit` on every route and for `since` on the journal.
 */
function wholeNumber(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new BadRequest(`\`${name}\` must be a whole number, got ${value}`);
  return number;
}

/** What `bd ready` and `bd list` narrow by, read from the query string as bd serve names the parameters; `limit=0` asks for all. */
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
  const limit = wholeNumber(url, "limit");
  if (type !== undefined) filter.type = type;
  if (status !== undefined) filter.status = status;
  if (assignee !== undefined) filter.assignee = assignee;
  if (parent !== undefined) filter.parent = parent;
  if (labels.length) filter.labels = labels;
  if (limit !== undefined && limit > 0) filter.limit = limit;
  return filter;
}

type Route = (url: URL, request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

/** One route: the method, the path pattern, and the handler given the pattern's captures. */
type Handler = (url: URL, request: http.IncomingMessage, response: http.ServerResponse, captures: string[]) => Promise<void>;

const ID = "([^/:]+)";

/**
 * The API: every route reads or writes the space through one bd call under an actor. Reads run as the
 * owner, the person the page serves; a close runs as the actor the body names, the human's name the
 * view sends, and the space wrapper's cooperative rules apply to it as to any other write. The table
 * is the one `docs/ui.md` lists.
 */
function apiRoutes(spec: UiSpec): Route {
  const space = (actor: string): Space => openSpace({ runner: spec.runner, env: spec.env, config: spec.config, actor: parseActor(actor) });
  const reads = space(spec.config.owner);
  const journal = journalReader(reads);

  /** The bead, or a 404 with bd's words when bd does not find it, on a read and on a close alike. */
  const showOr404 = async (by: Space, id: string, response: http.ServerResponse): Promise<Bead | undefined> => {
    try {
      return await by.show(id);
    } catch (error) {
      if (!(error instanceof SpaceError)) throw error;
      problem(response, 404, "not_found", `no bead ${id}: ${error.result.stderr.trim() || error.result.stdout.trim()}`);
      return undefined;
    }
  };

  const list: Handler = async (url, _request, response) => {
    const items = await reads.list(filterOf(url));
    reply(response, 200, "application/json", JSON.stringify({ items }));
  };
  const ready: Handler = async (url, _request, response) => {
    const items = await reads.ready(filterOf(url));
    reply(response, 200, "application/json", JSON.stringify({ items }));
  };
  const show: Handler = async (_url, _request, response, [id = ""]) => {
    const bead = await showOr404(reads, id, response);
    if (bead) reply(response, 200, "application/json", JSON.stringify(bead));
  };
  const events: Handler = async (url, _request, response) => {
    const since = wholeNumber(url, "since") ?? 0;
    const limit = wholeNumber(url, "limit") ?? 0;
    reply(response, 200, "application/json", JSON.stringify(await journal(since, limit)));
  };
  const close: Handler = async (_url, request, response, [id = ""]) => {
    let body: { actor?: unknown; reason?: unknown };
    try {
      body = JSON.parse((await readBody(request)) || "{}") as { actor?: unknown; reason?: unknown };
    } catch (error) {
      throw new BadRequest(`the body is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof body.actor !== "string" || body.actor.trim() === "") throw new BadRequest("`actor` is required");
    if (typeof body.reason !== "string" || body.reason.trim() === "") throw new BadRequest("`reason` is required");
    const writer = space(body.actor);
    const bead = await showOr404(writer, id, response);
    if (!bead) return;
    if (bead.status === "closed") {
      problem(response, 409, "conflict", `${id} is already closed`);
      return;
    }
    await writer.close(bead, body.reason);
    reply(response, 200, "application/json", JSON.stringify({ id, status: "closed" }));
  };

  const routes: readonly (readonly [method: string, pattern: RegExp, handler: Handler])[] = [
    ["GET", /^\/v0\/beads\/issues$/, list],
    ["GET", /^\/v0\/beads\/ready$/, ready],
    ["GET", new RegExp(`^/v0/beads/issues/${ID}$`), show],
    ["GET", /^\/v0\/beads\/events$/, events],
    ["POST", new RegExp(`^/v0/beads/issues/${ID}:close$`), close],
  ];

  return async (url, request, response) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "" || !tokens(spec.tokenFile).includes(token)) {
      problem(response, 401, "unauthorized", "missing or invalid bearer token");
      return;
    }
    try {
      for (const [method, pattern, handler] of routes) {
        const match = request.method === method ? pattern.exec(url.pathname) : null;
        if (match) {
          await handler(url, request, response, match.slice(1));
          return;
        }
      }
      problem(response, 404, "not_found", `no route ${request.method} ${url.pathname}`);
    } catch (error) {
      if (error instanceof BadRequest) problem(response, 400, "invalid_argument", error.message);
      else if (error instanceof RefusedError) problem(response, 403, "refused", error.message);
      else if (error instanceof SpaceError) problem(response, 409, "bd_refused", error.result.stderr.trim() || error.message);
      else problem(response, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * The journal route as the Activity view reads it: the head, the highest sequence number so far, and
 * the records after `since`, at most `limit` of them. bd tails the journal forward only, so the head is
 * learnt by reading what came after the last head seen: the whole journal on the first request of this
 * process, the new records on every later one. A read below the retention floor, which bd fails rather
 * than skipping ahead, takes the head from bd's answer and resumes from the oldest retained record.
 */
function journalReader(space: Space): (since: number, limit: number) => Promise<{ head: number; records: JournalEvent[] }> {
  let head = 0;
  const after = async (since: number, limit?: number): Promise<JournalEvent[]> => {
    try {
      return await space.events(since, limit);
    } catch (error) {
      if (!(error instanceof JournalTruncatedError)) throw error;
      head = Math.max(head, error.head);
      return space.events(error.floor - 1, limit);
    }
  };
  return async (since, limit) => {
    for (const record of await after(head)) head = Math.max(head, record.seq);
    const records = limit === 0 ? await after(since) : await after(since, limit);
    return { head, records };
  };
}
