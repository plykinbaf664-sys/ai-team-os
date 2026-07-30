import type { JsonObject, JsonValue } from "./types";

type FetchImplementation = typeof fetch;

type SupabaseRestClientOptions = {
  url: string;
  serviceRoleKey: string;
  fetchImplementation?: FetchImplementation;
};

type WriteOptions = {
  onConflict?: string;
};

type SelectOptions = {
  columns: string[];
  equals?: Record<string, string | number | boolean>;
  orderBy?: {
    column: string;
    ascending?: boolean;
  };
  limit?: number;
};

export class SupabaseRestError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(
    message: string,
    status: number,
    responseBody: string,
  ) {
    super(message);
    this.name = "SupabaseRestError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export type SupabaseRestClient = {
  select(table: string, options: SelectOptions): Promise<JsonObject[]>;
  insert(table: string, rows: JsonObject | JsonObject[]): Promise<JsonObject[]>;
  upsert(
    table: string,
    rows: JsonObject | JsonObject[],
    options: WriteOptions,
  ): Promise<JsonObject[]>;
  update(
    table: string,
    values: JsonObject,
    filters: Record<string, string>,
  ): Promise<JsonObject[]>;
  rpc(functionName: string, parameters: JsonObject): Promise<JsonValue>;
};

export function createSupabaseRestClient({
  url,
  serviceRoleKey,
  fetchImplementation = fetch,
}: SupabaseRestClientOptions): SupabaseRestClient {
  const normalizedUrl = url
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1$/i, "");
  const baseUrl = `${normalizedUrl}/rest/v1`;
  const isModernSecretKey = serviceRoleKey.startsWith("sb_secret_");
  const baseHeaders = {
    apikey: serviceRoleKey,
    "Content-Type": "application/json",
    ...(isModernSecretKey
      ? {}
      : { Authorization: `Bearer ${serviceRoleKey}` }),
  };

  async function request(
    path: string,
    init: RequestInit,
  ): Promise<JsonValue> {
    const response = await fetchImplementation(`${baseUrl}${path}`, init);
    const responseText = await response.text();

    if (!response.ok) {
      throw new SupabaseRestError(
        `Supabase REST request failed with status ${response.status}.`,
        response.status,
        responseText,
      );
    }

    return responseText ? (JSON.parse(responseText) as JsonValue) : null;
  }

  return {
    async select(table, options) {
      const query = new URLSearchParams({
        select: options.columns.join(","),
      });

      for (const [key, value] of Object.entries(options.equals ?? {})) {
        query.set(key, `eq.${String(value)}`);
      }

      if (options.orderBy) {
        query.set(
          "order",
          `${options.orderBy.column}.${options.orderBy.ascending ? "asc" : "desc"}`,
        );
      }

      if (options.limit !== undefined) {
        query.set("limit", String(options.limit));
      }

      const result = await request(
        `/${encodeURIComponent(table)}?${query.toString()}`,
        {
          method: "GET",
          headers: baseHeaders,
        },
      );

      return ensureRows(result);
    },

    async insert(table, rows) {
      const result = await request(`/${encodeURIComponent(table)}`, {
        method: "POST",
        headers: {
          ...baseHeaders,
          Prefer: "return=representation",
        },
        body: JSON.stringify(rows),
      });

      return ensureRows(result);
    },

    async upsert(table, rows, options) {
      const query = options.onConflict
        ? `?on_conflict=${encodeURIComponent(options.onConflict)}`
        : "";
      const result = await request(`/${encodeURIComponent(table)}${query}`, {
        method: "POST",
        headers: {
          ...baseHeaders,
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(rows),
      });

      return ensureRows(result);
    },

    async update(table, values, filters) {
      const query = new URLSearchParams(
        Object.entries(filters).map(([key, value]) => [key, `eq.${value}`]),
      );
      const result = await request(
        `/${encodeURIComponent(table)}?${query.toString()}`,
        {
          method: "PATCH",
          headers: {
            ...baseHeaders,
            Prefer: "return=representation",
          },
          body: JSON.stringify(values),
        },
      );

      return ensureRows(result);
    },

    rpc(functionName, parameters) {
      return request(`/rpc/${encodeURIComponent(functionName)}`, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(parameters),
      });
    },
  };
}

export function createSupabaseRestClientFromEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return null;
  }

  return createSupabaseRestClient({ url, serviceRoleKey });
}

function ensureRows(value: JsonValue): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error("Supabase REST response did not contain rows.");
  }

  return value.filter(isJsonObject);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
