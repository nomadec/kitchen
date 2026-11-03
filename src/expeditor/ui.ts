// The UI as the expeditor serves it (spec: UI, story 69): the bundled single-page app as static files,
// `/me` naming the owner the Pass view answers as, and every `/v0/...` and `/healthz` request passed
// through to bd serve on the same host, bearer token and all. One loopback port, so the page and the
// API share an origin (bd serve answers no cross-origin request) and a phone needs one tunnel. The
// server holds no credential: the token travels in each request and the SQL password never leaves bd.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { LOOPBACK } from "./serve.ts";

export interface UiSpec {
  /** The directory holding index.html and app.js, as `npm run build` writes them. */
  uiDir: string;
  owner: string;
  host: string;
  /** 0 takes an ephemeral port. */
  port: number;
  /** Where bd serve answers: `http://127.0.0.1:<port>`. */
  api: string;
}

export interface UiServer {
  url: string;
  close(): Promise<void>;
}

/** What `/me` answers: who the UI writes as, and where. No credential. */
export interface Me {
  owner: string;
  host: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

/** The request headers passed through to bd serve; the rest, Host above all, are the proxy's own. */
const PASSED_HEADERS = ["authorization", "content-type", "accept", "content-length"] as const;

export function startUi(spec: UiSpec): Promise<UiServer> {
  const api = new URL(spec.api);
  const uiDir = path.resolve(spec.uiDir);
  const me: Me = { owner: spec.owner, host: spec.host };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/v0/") || url.pathname === "/healthz") {
      proxy(api, request, response);
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
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function reply(response: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

/** Passes one request to bd serve and its answer back, status and body untouched; an unreachable bd serve is a 502. */
function proxy(api: URL, request: http.IncomingMessage, response: http.ServerResponse): void {
  const headers: Record<string, string> = {};
  for (const name of PASSED_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const upstream = http.request(
    { host: api.hostname, port: api.port, method: request.method, path: request.url, headers },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, { "content-type": answer.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
      answer.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    reply(response, 502, "application/json", JSON.stringify({ code: "bd_serve_unreachable", detail: `bd serve at ${api.origin} did not answer: ${error.message}`, status: 502, title: "Bad Gateway" }));
  });
  request.pipe(upstream);
}
