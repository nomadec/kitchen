// What every view shares of the API: the bearer token on each request, through the expeditor's own
// port, and a refusal (the token's, or the space's with its detail) as one error the page can show.

export interface ClientDeps {
  fetch: typeof fetch;
  /** The bearer token from the expeditor's token file. */
  token: string;
}

/** A refusal, by the view itself (no request made) or by the API (its status and detail). */
export class ViewError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ViewError";
    this.status = status;
  }
}

/** What the API answers a request it refuses. */
export interface Problem {
  detail?: string;
  code?: string;
}

export interface Client {
  /** One GET under the token: the status and the JSON body, refused or not, for the view to judge. */
  get<T>(path: string): Promise<{ status: number; body: T }>;
  /** The items of a list (`limit=0` asks for all of them), or the refusal as an error naming what was asked for. */
  list<T>(path: string, what: string): Promise<T[]>;
  post(path: string, body: unknown): Promise<{ status: number; body: Problem }>;
  refused(status: number, body: Problem, what: string): ViewError;
}

export function client(deps: ClientDeps): Client {
  const headers = { authorization: `Bearer ${deps.token}` };
  const refused = (status: number, body: Problem, what: string): ViewError =>
    status === 401
      ? new ViewError(`the token was refused: ${body.detail ?? "missing or invalid bearer token"}`, status)
      : new ViewError(`the space refused ${what}: ${body.detail ?? body.code ?? `status ${status}`}`, status);
  const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const response = await deps.fetch(path, { headers });
    return { status: response.status, body: (await response.json()) as T };
  };
  return {
    get,
    refused,
    list: async <T>(path: string, what: string): Promise<T[]> => {
      const { status, body } = await get<{ items: T[] } & Problem>(path);
      if (status !== 200) throw refused(status, body, what);
      return body.items;
    },
    post: async (path, body) => {
      const response = await deps.fetch(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as Problem };
    },
  };
}
