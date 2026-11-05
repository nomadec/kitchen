// The UI's test seam: a `fetch` scripted from a table of exchanges, recording every request it
// answers, the way the fake runner scripts `bd` for the CLI and the expeditor. Each view's data layer
// is exercised through the requests it makes to the API and nothing else.

export interface Exchange {
  method: string;
  url: string;
  status: number;
  body: string;
}

export interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export function scriptedFetch(table: readonly Exchange[]): { fetch: typeof globalThis.fetch; requests: Request[] } {
  const requests: Request[] = [];
  const scripted: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ method, url, headers, body: typeof init?.body === "string" ? init.body : undefined });
    const row = table.find((r) => r.method === method && r.url === url);
    if (!row) throw new Error(`Unexpected request: ${method} ${url}`);
    return new Response(row.body, { status: row.status, headers: { "content-type": "application/json" } });
  };
  return { fetch: scripted, requests };
}
