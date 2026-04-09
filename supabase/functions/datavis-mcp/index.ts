/**
 * OnlyFinders MCP Server (Only Agents)
 *
 * Supabase Edge Function exposing OnlyFinders tools as MCP operations.
 * Uses Streamable HTTP transport — clients connect via URL, not stdio.
 *
 * Tool domains:
 *   - Data Visualizer: chart CRUD, Google Sheets import, embedding
 *   - Product Watchtower: provider/product search, watchlist management
 *   - Niche Builder: schema discovery, provider/product CRUD via PAPI
 *
 * Endpoint: POST /datavis-mcp/mcp
 * Auth: x-api-key header checked against MCP_API_KEYS secret
 *
 * Required secrets:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Supabase access
 *   MCP_API_KEYS — comma-separated API keys for MCP auth
 *   GSHEET_WEBHOOK_URL, GSHEET_API_KEY — Google Sheets import (Data Viz)
 *   PRODUCT_API_USERNAME, PRODUCT_API_KEY — Finder Product API (Watchtower read)
 *   PAPI_WRITE_API_KEY — Finder Product API write access (Niche Builder)
 */

import { McpServer } from "npm:@modelcontextprotocol/sdk@1.27.1/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.27.1/server/webStandardStreamableHttp.js";
import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@^4.1.13";

// ---------------------------------------------------------------------------
// Supabase client (service role — full access, no RLS)
// ---------------------------------------------------------------------------

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GSHEET_WEBHOOK_URL =
  Deno.env.get("GSHEET_WEBHOOK_URL") ??
  "https://finderai.app.n8n.cloud/webhook/datavis-gsheet";
const GSHEET_API_KEY = Deno.env.get("GSHEET_API_KEY") ?? "";

const WORKSPACES = [
  { id: "global", code: "GX", name: "Global" },
  { id: "us", code: "US", name: "United States" },
  { id: "uk", code: "UK", name: "United Kingdom" },
  { id: "ca", code: "CA", name: "Canada" },
  { id: "au", code: "AU", name: "Australia" },
];

const CHART_TYPES = [
  "bar",
  "line",
  "pie",
  "doughnut",
  "area",
  "scatter",
  "radar",
  "polarArea",
  "table",
  "map",
  "suburb-map",
  "world-map",
  "us-map",
  "canada-map",
  "uk-map",
] as const;

const EMBED_BASE_URL = "https://www.finderops.ai";

// ---------------------------------------------------------------------------
// Product API (PAPI) — used by Watchtower tools
// ---------------------------------------------------------------------------

const PAPI_BASE = "https://product.api.production-02.fndr.systems/api/v117";
const PAPI_USERNAME = Deno.env.get("PRODUCT_API_USERNAME") ?? "";
const PAPI_KEY = Deno.env.get("PRODUCT_API_KEY") ?? "";
const PAPI_WRITE_KEY = Deno.env.get("PAPI_WRITE_API_KEY") ?? "";

async function fetchPAPI(path: string): Promise<unknown> {
  if (!PAPI_USERNAME || !PAPI_KEY) {
    throw new Error("Product API credentials not configured");
  }
  const res = await fetch(`${PAPI_BASE}${path}`, {
    headers: {
      "X-Auth-Username": PAPI_USERNAME,
      "X-API-Key": PAPI_KEY,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PAPI ${res.status}: ${text}`);
  }
  return res.json();
}

async function writePAPI(
  method: "POST" | "PUT",
  path: string,
  body: unknown,
): Promise<unknown> {
  if (!PAPI_WRITE_KEY) {
    throw new Error("Product API write credentials not configured");
  }
  if (!currentUserEmail) {
    throw new Error(
      "x-user-email header is required for write operations. Add it to your MCP config headers.",
    );
  }
  const res = await fetch(`${PAPI_BASE}${path}`, {
    method,
    headers: {
      "X-Auth-Username": currentUserEmail,
      "X-Auth-Password": PAPI_WRITE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PAPI ${method} ${res.status}: ${text}`);
  }
  // Some write endpoints return 201/204 with no body
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return { status: res.status, statusText: res.statusText };
}

async function deletePAPI(path: string): Promise<unknown> {
  if (!PAPI_WRITE_KEY) {
    throw new Error("Product API write credentials not configured");
  }
  if (!currentUserEmail) {
    throw new Error(
      "x-user-email header is required for write operations. Add it to your MCP config headers.",
    );
  }
  const res = await fetch(`${PAPI_BASE}${path}`, {
    method: "DELETE",
    headers: {
      "X-Auth-Username": currentUserEmail,
      "X-Auth-Password": PAPI_WRITE_KEY,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PAPI DELETE ${res.status}: ${text}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return { status: res.status, statusText: res.statusText };
}

/**
 * Fetch all providers for a niche from PAPI. Paginates server-side.
 * Returns array of { id, name }.
 */
async function fetchNicheProviders(
  nicheCode: string,
): Promise<Array<{ id: string; name: string }>> {
  const providers: Array<{ id: string; name: string }> = [];

  const first = (await fetchPAPI(
    `/niches/${nicheCode}/data/providers?format=minimal&offset=0`,
  )) as { count?: number; items?: unknown[] };
  const totalCount = first.count || 0;

  for (const p of first.items || []) {
    const v =
      (p as { calculated?: { values?: Record<string, unknown> } }).calculated
        ?.values || {};
    const id = v["GENERAL.ID"] as string;
    const name = v["GENERAL.NAME"] as string;
    if (id && name) providers.push({ id, name });
  }

  if (totalCount > 20) {
    const offsets: number[] = [];
    for (let o = 20; o < totalCount; o += 20) offsets.push(o);

    // Fetch in parallel batches of 5
    for (let i = 0; i < offsets.length; i += 5) {
      const batch = offsets.slice(i, i + 5);
      const results = await Promise.all(
        batch.map((o) =>
          fetchPAPI(
            `/niches/${nicheCode}/data/providers?format=minimal&offset=${o}`,
          ),
        ),
      );
      for (const data of results) {
        for (const p of (data as { items?: unknown[] }).items || []) {
          const v =
            (p as { calculated?: { values?: Record<string, unknown> } })
              .calculated?.values || {};
          const id = v["GENERAL.ID"] as string;
          const name = v["GENERAL.NAME"] as string;
          if (id && name) providers.push({ id, name });
        }
      }
    }
  }

  providers.sort((a, b) => a.name.localeCompare(b.name));
  return providers;
}

/**
 * Fetch products for a niche, optionally filtered by provider.
 * Uses PAPI's RSQL filter when provider is specified.
 */
async function fetchNicheProducts(
  nicheCode: string,
  providerId?: string,
): Promise<
  Array<{
    id: string;
    name: string;
    providerId: string | null;
    active: unknown;
  }>
> {
  const products: Array<{
    id: string;
    name: string;
    providerId: string | null;
    active: unknown;
  }> = [];
  const filterParam = providerId
    ? `&filter=${encodeURIComponent(`GENERAL.PROVIDER_ID=="${providerId}"`)}`
    : "";

  const first = (await fetchPAPI(
    `/niches/${nicheCode}/data/products?format=minimal&offset=0${filterParam}`,
  )) as { count?: number; items?: unknown[] };
  const totalCount = first.count || 0;

  const extract = (p: unknown) => {
    const v =
      (p as { calculated?: { values?: Record<string, unknown> } }).calculated
        ?.values || {};
    return {
      id: v["GENERAL.ID"] as string,
      name: v["GENERAL.NAME"] as string,
      providerId: (v["GENERAL.PROVIDER_ID"] as string) || null,
      active: v["GENERAL.ACTIVE"],
    };
  };

  for (const p of first.items || []) products.push(extract(p));

  if (totalCount > 20) {
    const offsets: number[] = [];
    for (let o = 20; o < totalCount; o += 20) offsets.push(o);

    for (let i = 0; i < offsets.length; i += 10) {
      const batch = offsets.slice(i, i + 10);
      const results = await Promise.all(
        batch.map((o) =>
          fetchPAPI(
            `/niches/${nicheCode}/data/products?format=minimal&offset=${o}${filterParam}`,
          ),
        ),
      );
      for (const data of results) {
        for (const p of (data as { items?: unknown[] }).items || []) {
          products.push(extract(p));
        }
      }
    }
  }

  products.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return products;
}

/**
 * Fuzzy match a query against a name. Returns a score (0 = no match).
 * All query tokens must appear in the name for a match.
 */
function fuzzyScore(name: string, query: string): number {
  const nameLower = name.toLowerCase();
  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(Boolean);

  if (queryTokens.length === 0) return 0;
  if (!queryTokens.every((t) => nameLower.includes(t))) return 0;

  // Exact match
  if (nameLower === queryLower) return 100;

  let score = 50;
  // Name starts with query → strong signal
  if (nameLower.startsWith(queryLower)) score += 30;
  // Shorter names that match are more specific
  score += Math.max(0, 20 - (nameLower.length - queryLower.length));

  return score;
}

/**
 * Calculate the next scheduled run time.
 */
function calcNextRun(frequency: string): string | null {
  const next = new Date();
  switch (frequency) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(6, 0, 0, 0);
      return next.toISOString();
    case "twice_weekly": {
      const day = next.getUTCDay();
      const daysToMon = (1 - day + 7) % 7 || 7;
      const daysToThu = (4 - day + 7) % 7 || 7;
      next.setUTCDate(next.getUTCDate() + Math.min(daysToMon, daysToThu));
      next.setUTCHours(6, 0, 0, 0);
      return next.toISOString();
    }
    case "weekly": {
      const dayW = next.getUTCDay();
      next.setUTCDate(next.getUTCDate() + ((1 - dayW + 7) % 7 || 7));
      next.setUTCHours(6, 0, 0, 0);
      return next.toISOString();
    }
    case "twice_monthly":
      if (next.getUTCDate() < 15) {
        next.setUTCDate(15);
      } else {
        next.setUTCMonth(next.getUTCMonth() + 1, 1);
      }
      next.setUTCHours(6, 0, 0, 0);
      return next.toISOString();
    case "monthly":
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      next.setUTCHours(6, 0, 0, 0);
      return next.toISOString();
    default:
      return null; // manual
  }
}

const SCHEDULE_FREQUENCIES = [
  "daily",
  "twice_weekly",
  "weekly",
  "twice_monthly",
  "monthly",
  "manual",
] as const;

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "onlyfinders",
  version: "3.0.0",
});

// ---- list_workspaces -------------------------------------------------------

server.registerTool(
  "list_workspaces",
  {
    title: "List Workspaces",
    description:
      "List all available Data Visualizer workspaces (markets). Each workspace scopes folders and charts to a Finder market.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => ({
    content: [{ type: "text", text: JSON.stringify(WORKSPACES, null, 2) }],
  }),
);

// ---- list_folders ----------------------------------------------------------

server.registerTool(
  "list_folders",
  {
    title: "List Folders",
    description:
      "List all folders in a workspace. Folders organise charts within a market.",
    inputSchema: {
      workspace_id: z
        .enum(["global", "us", "uk", "ca", "au"])
        .describe("Workspace / market ID"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ workspace_id }) => {
    const { data, error } = await supabase
      .from("data_visualizer_folders")
      .select("id, name, description, created_at")
      .eq("workspace_id", workspace_id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("list_folders error:", error);
      throw new Error("Failed to list folders");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- list_charts -----------------------------------------------------------

server.registerTool(
  "list_charts",
  {
    title: "List Charts",
    description:
      "List charts in a workspace, optionally filtered to a specific folder. Returns chart metadata without full data payloads.",
    inputSchema: {
      workspace_id: z
        .enum(["global", "us", "uk", "ca", "au"])
        .describe("Workspace / market ID"),
      folder_id: z
        .string()
        .uuid()
        .optional()
        .describe("Filter to a specific folder (UUID)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max charts to return (default 50, max 200)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ workspace_id, folder_id, limit }) => {
    let query = supabase
      .from("data_visualizer_charts")
      .select(
        "id, name, chart_type, workspace_id, folder_id, is_public, created_by, created_at, updated_at",
      )
      .eq("workspace_id", workspace_id)
      .order("created_at", { ascending: false })
      .limit(limit ?? 50);

    if (folder_id) {
      query = query.eq("folder_id", folder_id);
    }

    const { data, error } = await query;
    if (error) {
      console.error("list_charts error:", error);
      throw new Error("Failed to list charts");
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- get_chart -------------------------------------------------------------

server.registerTool(
  "get_chart",
  {
    title: "Get Chart",
    description:
      "Get a single chart by ID, including full data payload and config.",
    inputSchema: {
      chart_id: z.string().uuid().describe("Chart UUID"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ chart_id }) => {
    const { data, error } = await supabase
      .from("data_visualizer_charts")
      .select("*")
      .eq("id", chart_id)
      .single();

    if (error) {
      console.error("get_chart error:", error);
      throw new Error("Failed to fetch chart");
    }
    if (!data) throw new Error("Chart not found");

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- fetch_sheet_tabs ------------------------------------------------------

server.registerTool(
  "fetch_sheet_tabs",
  {
    title: "Fetch Google Sheet Tabs",
    description:
      "Given a Google Sheets URL, fetch the list of sheet/tab names. Use this before fetch_sheet_data to let the user (or AI) pick which tab to import.",
    inputSchema: {
      spreadsheet_url: z.string().describe("Full Google Sheets URL"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ spreadsheet_url }) => {
    const match = spreadsheet_url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error("Invalid Google Sheets URL");

    const res = await fetch(GSHEET_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": GSHEET_API_KEY,
      },
      body: JSON.stringify({ mode: "tabs", spreadsheetId: match[1] }),
    });

    if (!res.ok) throw new Error(`n8n proxy error (${res.status})`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);

    return {
      content: [{ type: "text", text: JSON.stringify(json.tabs, null, 2) }],
    };
  },
);

// ---- fetch_sheet_data ------------------------------------------------------

server.registerTool(
  "fetch_sheet_data",
  {
    title: "Fetch Google Sheet Data",
    description:
      "Fetch row data from a specific tab of a Google Sheet. Returns headers and rows. Use after fetch_sheet_tabs to know which tab to request.",
    inputSchema: {
      spreadsheet_url: z.string().describe("Full Google Sheets URL"),
      tab_name: z.string().describe("Sheet tab name to import"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ spreadsheet_url, tab_name }) => {
    const match = spreadsheet_url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error("Invalid Google Sheets URL");

    const res = await fetch(GSHEET_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": GSHEET_API_KEY,
      },
      body: JSON.stringify({
        mode: "data",
        spreadsheetId: match[1],
        sheetName: tab_name,
      }),
    });

    if (!res.ok) throw new Error(`n8n proxy error (${res.status})`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              headers: json.headers,
              row_count: json.rows?.length ?? 0,
              rows: json.rows,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- create_chart ----------------------------------------------------------

server.registerTool(
  "create_chart",
  {
    title: "Create Chart",
    description: `Create a new Data Visualizer chart. The AI should prepare chart_data in the standard shape:
{
  "labels": ["Jan", "Feb", ...],
  "labelHeader": "Month",
  "datasets": [
    { "label": "Revenue", "data": [100, 200, ...] }
  ]
}
chart_config controls display options (title, legend, axes, source attribution).`,
    inputSchema: {
      name: z.string().describe("Chart name"),
      chart_type: z
        .enum(CHART_TYPES)
        .describe(
          "Chart type (bar, line, pie, doughnut, area, scatter, radar, polarArea, table)",
        ),
      workspace_id: z
        .enum(["global", "us", "uk", "ca", "au"])
        .describe("Target workspace / market"),
      folder_id: z.string().uuid().describe("Target folder UUID"),
      chart_data: z
        .record(z.string(), z.any())
        .describe(
          "Chart data object with labels (string[]), labelHeader (string), and datasets (array of {label, data})",
        ),
      chart_config: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Display config: title, showLegend, legendPosition, showGrid, beginAtZero, smooth, xAxisLabel, yAxisLabel, source",
        ),
      created_by: z
        .string()
        .optional()
        .describe("Email or name of the creator (for attribution)"),
    },
  },
  async ({
    name,
    chart_type,
    workspace_id,
    folder_id,
    chart_data,
    chart_config,
    created_by,
  }) => {
    const config = {
      showLegend: true,
      legendPosition: "top",
      showGrid: true,
      beginAtZero: true,
      smooth: false,
      title: "",
      xAxisLabel: "",
      yAxisLabel: "",
      source: "",
      ...(chart_config ?? {}),
    };

    const { data, error } = await supabase
      .from("data_visualizer_charts")
      .insert({
        name,
        chart_type,
        chart_data,
        chart_config: config,
        workspace_id,
        folder_id,
        created_by: created_by ?? "MCP",
      })
      .select("id, name, chart_type, share_token, is_public, created_at")
      .single();

    if (error) {
      console.error("create_chart error:", error);
      throw new Error("Failed to create chart");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...data,
              url: `${EMBED_BASE_URL}/global/pr/data-visualizer/${folder_id}/${data.id}`,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- update_chart ----------------------------------------------------------

server.registerTool(
  "update_chart",
  {
    title: "Update Chart",
    description:
      "Update an existing chart. Only include fields you want to change.",
    inputSchema: {
      chart_id: z.string().uuid().describe("Chart UUID to update"),
      name: z.string().optional().describe("New chart name"),
      chart_type: z.enum(CHART_TYPES).optional().describe("New chart type"),
      chart_data: z
        .record(z.string(), z.any())
        .optional()
        .describe("New chart data payload"),
      chart_config: z
        .record(z.string(), z.any())
        .optional()
        .describe("New chart config (merged with existing)"),
    },
  },
  async ({ chart_id, name, chart_type, chart_data, chart_config }) => {
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (name !== undefined) updates.name = name;
    if (chart_type !== undefined) updates.chart_type = chart_type;
    if (chart_data !== undefined) updates.chart_data = chart_data;
    if (chart_config !== undefined) updates.chart_config = chart_config;

    const { data, error } = await supabase
      .from("data_visualizer_charts")
      .update(updates)
      .eq("id", chart_id)
      .select("id, name, chart_type, updated_at")
      .single();

    if (error) {
      console.error("update_chart error:", error);
      throw new Error("Failed to update chart");
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- set_chart_visibility --------------------------------------------------

server.registerTool(
  "set_chart_visibility",
  {
    title: "Set Chart Visibility",
    description:
      "Make a chart public (embeddable) or private. Public charts get a share_token for WordPress embedding.",
    inputSchema: {
      chart_id: z.string().uuid().describe("Chart UUID"),
      is_public: z.boolean().describe("true = public, false = private"),
    },
  },
  async ({ chart_id, is_public }) => {
    const { data, error } = await supabase
      .from("data_visualizer_charts")
      .update({ is_public })
      .eq("id", chart_id)
      .select("id, name, is_public, share_token")
      .single();

    if (error) {
      console.error("set_chart_visibility error:", error);
      throw new Error("Failed to update chart visibility");
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ---- get_embed_code --------------------------------------------------------

server.registerTool(
  "get_embed_code",
  {
    title: "Get Embed Code",
    description:
      "Get the WordPress shortcode and embed URL for a public chart. Returns both the partial shortcode (for WordPress) and a raw iframe snippet.",
    inputSchema: {
      chart_id: z.string().uuid().describe("Chart UUID"),
      target_market: z
        .enum(["us", "au", "uk", "ca"])
        .optional()
        .default("us")
        .describe(
          "Target market for embed. UK/CA use a global partial. Default: us",
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ chart_id, target_market }) => {
    const { data, error } = await supabase
      .from("data_visualizer_charts")
      .select("id, name, share_token, is_public")
      .eq("id", chart_id)
      .single();

    if (error) {
      console.error("get_embed_code error:", error);
      throw new Error("Failed to fetch chart");
    }
    if (!data) throw new Error("Chart not found");
    if (!data.is_public)
      throw new Error("Chart is not public. Use set_chart_visibility first.");
    if (!data.share_token) throw new Error("Chart has no share token");

    const market = target_market ?? "us";
    const useGlobalPartial = market === "uk" || market === "ca";
    const partialCode = useGlobalPartial
      ? `[partial id="1885547" global="true" chart="${data.share_token}"]`
      : `[partial id="datavis" chart="${data.share_token}"]`;

    const embedUrl = `${EMBED_BASE_URL}/embed/${data.share_token}`;
    const safeName = data.name
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const iframe = `<iframe src="${embedUrl}" width="100%" height="450" frameborder="0" style="border:0;border-radius:8px" loading="lazy" title="${safeName}"></iframe>`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              chart_name: data.name,
              target_market: market,
              wordpress_partial: partialCode,
              embed_url: embedUrl,
              iframe: iframe,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ===========================================================================
// PRODUCT WATCHTOWER TOOLS
// ===========================================================================

// ---- list_niches (watchtower) -----------------------------------------------

server.registerTool(
  "list_niches",
  {
    title: "List Configured Niches",
    description:
      "List product niches that have been configured for Watchtower monitoring in a given country. Only configured niches (with field schemas ready) can have watchlist items added.",
    inputSchema: {
      country_code: z
        .string()
        .describe("Lowercase country code (e.g. 'us', 'au', 'uk', 'ca')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ country_code }) => {
    const { data, error } = await supabase
      .from("pw_niche_configs")
      .select("niche_code, country_code, status, created_at, updated_at")
      .eq("country_code", country_code.toLowerCase())
      .eq("status", "ready")
      .order("niche_code");

    if (error) {
      console.error("list_niches error:", error);
      throw new Error("Failed to list niche configs");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { country_code: country_code.toLowerCase(), niches: data },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- search_providers (watchtower) ------------------------------------------

server.registerTool(
  "search_providers",
  {
    title: "Search Providers",
    description:
      "Fuzzy search for providers across all configured Watchtower niches in a country. Use this to find a provider when you know their name but not which niche they belong to. Returns matching providers grouped by niche, sorted by match quality.",
    inputSchema: {
      query: z
        .string()
        .describe("Provider name to search for (e.g. 'Chase Bank', 'Amex')"),
      country_code: z
        .string()
        .describe("Lowercase country code (e.g. 'us', 'au')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, country_code }) => {
    // Get configured niches for this country
    const { data: configs, error: configErr } = await supabase
      .from("pw_niche_configs")
      .select("niche_code")
      .eq("country_code", country_code.toLowerCase())
      .eq("status", "ready");

    if (configErr) {
      console.error("search_providers config error:", configErr);
      throw new Error("Failed to fetch niche configs");
    }

    if (!configs || configs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                country_code: country_code.toLowerCase(),
                matches: [],
                message: "No configured niches found for this country.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Search providers in each configured niche in parallel
    const results = await Promise.allSettled(
      configs.map(async (c) => {
        const providers = await fetchNicheProviders(c.niche_code);
        return { niche_code: c.niche_code, providers };
      }),
    );

    // Score and collect matches
    const matches: Array<{
      niche_code: string;
      provider_id: string;
      provider_name: string;
      score: number;
    }> = [];

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { niche_code, providers } = result.value;

      for (const provider of providers) {
        const score = fuzzyScore(provider.name, query);
        if (score > 0) {
          matches.push({
            niche_code,
            provider_id: provider.id,
            provider_name: provider.name,
            score,
          });
        }
      }
    }

    // Sort by score descending, then by name
    matches.sort(
      (a, b) =>
        b.score - a.score || a.provider_name.localeCompare(b.provider_name),
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              country_code: country_code.toLowerCase(),
              niches_searched: configs.length,
              matches,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- list_niche_providers (watchtower) --------------------------------------

server.registerTool(
  "list_niche_providers",
  {
    title: "List Niche Providers",
    description:
      "List all providers in a specific product niche from the Product API. Use after search_providers to see all providers in a niche, or to browse providers before adding to a watchlist.",
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USCCF', 'AUFHI-NEW')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ niche_code }) => {
    const providers = await fetchNicheProviders(niche_code);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { niche_code, count: providers.length, providers },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- list_provider_products (watchtower) ------------------------------------

server.registerTool(
  "list_provider_products",
  {
    title: "List Provider Products",
    description:
      "List products from a specific provider in a niche. Use after selecting a provider to see which individual products can be added to the watchlist.",
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USCCF')"),
      provider_id: z.string().describe("Provider ID from PAPI"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ niche_code, provider_id }) => {
    const products = await fetchNicheProducts(niche_code, provider_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              niche_code,
              provider_id,
              count: products.length,
              products,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- add_watchlist_items (watchtower) ----------------------------------------

server.registerTool(
  "add_watchlist_items",
  {
    title: "Add Watchlist Items",
    description: `Add providers and/or products to the Product Watchtower watchlist. Items inherit their field configuration from the niche config automatically.

Each item needs: entity_type (provider or product), entity_id, entity_name, niche_code. Products should also include provider_id and provider_name.

The schedule_frequency applies to all items in the batch. Items are upserted — duplicates (same entity_type + entity_id + niche_code) are skipped.`,
    inputSchema: {
      country_code: z
        .string()
        .describe("Lowercase country code (e.g. 'us', 'au')"),
      niche_code: z.string().describe("Niche code (e.g. 'USCCF')"),
      schedule_frequency: z
        .enum(SCHEDULE_FREQUENCIES)
        .describe(
          "How often to check: daily, twice_weekly, weekly, twice_monthly, monthly, manual",
        ),
      items: z
        .array(
          z.object({
            entity_type: z
              .enum(["provider", "product"])
              .describe("'provider' or 'product'"),
            entity_id: z.string().describe("Entity ID from PAPI"),
            entity_name: z.string().describe("Entity display name"),
            provider_id: z
              .string()
              .optional()
              .describe("Provider ID (required for products)"),
            provider_name: z
              .string()
              .optional()
              .describe("Provider name (required for products)"),
          }),
        )
        .describe("Array of items to add to the watchlist"),
    },
  },
  async ({ country_code, niche_code, schedule_frequency, items }) => {
    const cc = country_code.toLowerCase();

    // Fetch niche config for field schema inheritance
    const { data: config, error: configErr } = await supabase
      .from("pw_niche_configs")
      .select("*")
      .eq("niche_code", niche_code)
      .eq("country_code", cc)
      .eq("status", "ready")
      .single();

    if (configErr || !config) {
      throw new Error(
        `Niche '${niche_code}' is not configured for country '${cc}'. Use list_niches to see available niches.`,
      );
    }

    const nextRun = calcNextRun(schedule_frequency);

    const rows = items.map((item) => {
      const isProduct = item.entity_type === "product";
      const fieldSchema = isProduct
        ? config.product_field_schema
        : config.provider_field_schema;
      const hasFields = fieldSchema && fieldSchema.length > 0;

      return {
        entity_type: item.entity_type,
        entity_id: item.entity_id,
        entity_name: item.entity_name,
        niche_code,
        country_code: cc,
        provider_id: item.provider_id || null,
        provider_name: item.provider_name || null,
        schedule_frequency,
        schedule_next_run_at: nextRun,
        status: hasFields ? "active" : "pending_fields",
        ...(hasFields && {
          field_config: fieldSchema,
          field_config_version: 1,
        }),
      };
    });

    const { data, error } = await supabase
      .from("pw_watchlist_items")
      .upsert(rows, {
        onConflict: "entity_type,entity_id,niche_code",
        ignoreDuplicates: true,
      })
      .select();

    if (error) {
      console.error("add_watchlist_items error:", error);
      throw new Error("Failed to add watchlist items");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              added: data?.length ?? 0,
              schedule_frequency,
              next_run: nextRun,
              items: data,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- list_watchlist (watchtower) --------------------------------------------

server.registerTool(
  "list_watchlist",
  {
    title: "List Watchlist",
    description:
      "List current Product Watchtower items for a country, optionally filtered by niche. Shows what's being monitored and their schedule/status.",
    inputSchema: {
      country_code: z
        .string()
        .describe("Lowercase country code (e.g. 'us', 'au')"),
      niche_code: z
        .string()
        .optional()
        .describe("Filter to a specific niche code"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max items to return (default 50, max 200)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ country_code, niche_code, limit }) => {
    let query = supabase
      .from("pw_watchlist_items")
      .select(
        "id, entity_type, entity_id, entity_name, niche_code, country_code, provider_id, provider_name, schedule_frequency, schedule_next_run_at, status, created_at",
      )
      .eq("country_code", country_code.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(limit ?? 50);

    if (niche_code) {
      query = query.eq("niche_code", niche_code);
    }

    const { data, error } = await query;

    if (error) {
      console.error("list_watchlist error:", error);
      throw new Error("Failed to list watchlist items");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              country_code: country_code.toLowerCase(),
              ...(niche_code && { niche_code }),
              count: data?.length ?? 0,
              items: data,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ===========================================================================
// NICHE BUILDER TOOLS
// ===========================================================================

// ---- get_niche_schema -------------------------------------------------------

server.registerTool(
  "get_niche_schema",
  {
    title: "Get Niche Schema",
    description: `Get the core field schema for products or providers in a niche. Returns fields with their types, required flags, and validation rules.

IMPORTANT: This returns the core schema (GENERAL.* fields) only. Real products/providers have many more fields across groups like RATES, FEES, DETAILS, IMAGES, LINKS, DESCRIPTIONS, etc. To see the full field set for a niche, use get_product or get_provider on an existing entity — that shows all 100+ fields with their current values, which is the best reference for creating new entities.

Recommended workflow:
1. get_niche_schema → understand required core fields
2. get_product on an existing product in the same niche → see the full field structure
3. Use both as reference when creating a new entity`,
    inputSchema: {
      niche_code: z
        .string()
        .describe("Niche code (e.g. 'USFSA', 'USCCF', 'AUFHI-NEW')"),
      record_type: z
        .enum(["product", "provider"])
        .describe("Whether to get the product or provider schema"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ niche_code, record_type }) => {
    const schema = await fetchPAPI(
      `/niches/${niche_code}/schema/${record_type}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ niche_code, record_type, schema }, null, 2),
        },
      ],
    };
  },
);

// ---- get_provider -----------------------------------------------------------

server.registerTool(
  "get_provider",
  {
    title: "Get Provider",
    description:
      "Get full details of a single provider including all field values. Use this to inspect a provider before updating, or to verify a newly created provider.",
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USFSA')"),
      provider_id: z.string().describe("Provider UUID from PAPI"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ niche_code, provider_id }) => {
    const provider = await fetchPAPI(
      `/niches/${niche_code}/data/providers/${provider_id}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ niche_code, provider }, null, 2),
        },
      ],
    };
  },
);

// ---- get_product ------------------------------------------------------------

server.registerTool(
  "get_product",
  {
    title: "Get Product",
    description:
      "Get full details of a single product including all field values. Use this to inspect a product before updating, or to verify a newly created product.",
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USFSA')"),
      product_id: z.string().describe("Product UUID from PAPI"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ niche_code, product_id }) => {
    const product = await fetchPAPI(
      `/niches/${niche_code}/data/products/${product_id}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ niche_code, product }, null, 2),
        },
      ],
    };
  },
);

// ---- create_provider --------------------------------------------------------

server.registerTool(
  "create_provider",
  {
    title: "Create Provider",
    description: `Create a new provider in a niche. Values must be locale-keyed objects.

Example values:
{
  "GENERAL.NAME": { "en-US": "TD Bank" },
  "GENERAL.ACTIVE": { "en-US": true },
  "IMAGES.LOGO": { "en-US": "https://example.com/logo.png" }
}

Recommended workflow: call niche_builder_guide first, then use get_provider on an existing provider in the same niche as a field reference.

IMPORTANT: Only populate verifiable data fields — DETAILS.*, LINKS.*, TRUST.*, and required GENERAL fields. Leave DESCRIPTIONS.*, DEALS.*, COMMERCIALS.*, IMAGES.*, and internal flags blank. See niche_builder_guide for the full list of fields to populate vs skip.`,
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USFSA')"),
      values: z
        .record(z.string(), z.record(z.string(), z.any()))
        .describe(
          "Field values as locale-keyed objects, e.g. { 'GENERAL.NAME': { 'en-US': 'TD Bank' } }",
        ),
    },
  },
  async ({ niche_code, values }) => {
    const result = await writePAPI(
      "POST",
      `/niches/${niche_code}/data/providers`,
      { values },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { niche_code, action: "created", provider: result },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- create_product ---------------------------------------------------------

server.registerTool(
  "create_product",
  {
    title: "Create Product",
    description: `Create a new product in a niche. Values must be locale-keyed objects.

Example values:
{
  "GENERAL.NAME": { "en-US": "TD Essential Checking" },
  "GENERAL.ACTIVE": { "en-US": true },
  "GENERAL.PROVIDER_ID": { "en-US": "uuid-of-td-bank" },
  "GENERAL.AFFILIATE_URL": { "en-US": "https://www.tdbank.com/..." }
}

Recommended workflow: call niche_builder_guide first, then use get_product on an existing product in the same niche as a field reference.

IMPORTANT: Only populate verifiable data fields — RATES.*, FEES.*, REQUIREMENTS.*, DETAILS.*, and LINKS (provider URL, terms URL). Leave DESCRIPTIONS.*, DEALS.*, COMMERCIALS.*, IMAGES.*, OFFER.*, and internal flags blank. Editors will fill in editorial content separately. See niche_builder_guide for the full list of fields to populate vs skip.`,
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USFSA')"),
      values: z
        .record(z.string(), z.record(z.string(), z.any()))
        .describe(
          "Field values as locale-keyed objects, e.g. { 'GENERAL.NAME': { 'en-US': 'Product Name' } }",
        ),
    },
  },
  async ({ niche_code, values }) => {
    const result = await writePAPI(
      "POST",
      `/niches/${niche_code}/data/products`,
      { values },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { niche_code, action: "created", product: result },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- update_provider --------------------------------------------------------

server.registerTool(
  "update_provider",
  {
    title: "Update Provider",
    description: `Update an existing provider's fields. Only include fields you want to change — this is a true partial update (read-merge-write). Values must be locale-keyed.

Internally reads the current provider, merges your changes on top, then PUTs the full object. Safe to call with just the fields you want to change.`,
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USFSA')"),
      provider_id: z.string().describe("Provider UUID to update"),
      values: z
        .record(z.string(), z.record(z.string(), z.any()))
        .describe("Field values to update (locale-keyed objects)"),
    },
  },
  async ({ niche_code, provider_id, values }) => {
    // Read-merge-write: PAPI PUT replaces ALL values, so we must read first
    const existing = (await fetchPAPI(
      `/niches/${niche_code}/data/providers/${provider_id}`,
    )) as { values: Record<string, Record<string, unknown>> };
    const merged = { ...existing.values, ...values };
    const result = await writePAPI(
      "PUT",
      `/niches/${niche_code}/data/providers/${provider_id}`,
      { values: merged },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              niche_code,
              provider_id,
              action: "updated",
              fields_changed: Object.keys(values),
              result,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- update_product ---------------------------------------------------------

server.registerTool(
  "update_product",
  {
    title: "Update Product",
    description: `Update an existing product's fields. Only include fields you want to change — this is a true partial update (read-merge-write). Values must be locale-keyed.

Internally reads the current product, merges your changes on top, then PUTs the full object. Safe to call with just the fields you want to change.`,
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USFSA')"),
      product_id: z.string().describe("Product UUID to update"),
      values: z
        .record(z.string(), z.record(z.string(), z.any()))
        .describe("Field values to update (locale-keyed objects)"),
    },
  },
  async ({ niche_code, product_id, values }) => {
    // Read-merge-write: PAPI PUT replaces ALL values, so we must read first
    const existing = (await fetchPAPI(
      `/niches/${niche_code}/data/products/${product_id}`,
    )) as { values: Record<string, Record<string, unknown>> };
    const merged = { ...existing.values, ...values };
    const result = await writePAPI(
      "PUT",
      `/niches/${niche_code}/data/products/${product_id}`,
      { values: merged },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              niche_code,
              product_id,
              action: "updated",
              fields_changed: Object.keys(values),
              result,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- delete_provider --------------------------------------------------------

server.registerTool(
  "delete_provider",
  {
    title: "Delete Provider",
    description:
      "Delete a provider from a niche. This is a hard delete — use with caution. Consider setting GENERAL.ACTIVE to false via update_provider for a soft disable instead.",
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USFSA')"),
      provider_id: z.string().describe("Provider UUID to delete"),
    },
  },
  async ({ niche_code, provider_id }) => {
    const result = await deletePAPI(
      `/niches/${niche_code}/data/providers/${provider_id}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { niche_code, provider_id, action: "deleted", result },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- delete_product ---------------------------------------------------------

server.registerTool(
  "delete_product",
  {
    title: "Delete Product",
    description:
      "Delete a product from a niche. This is a hard delete — use with caution. Consider setting GENERAL.ACTIVE to false via update_product for a soft disable instead.",
    inputSchema: {
      niche_code: z.string().describe("Niche code (e.g. 'USFSA')"),
      product_id: z.string().describe("Product UUID to delete"),
    },
  },
  async ({ niche_code, product_id }) => {
    const result = await deletePAPI(
      `/niches/${niche_code}/data/products/${product_id}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { niche_code, product_id, action: "deleted", result },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- fact_check_product -----------------------------------------------------

/**
 * Field groups that contain externally verifiable product data.
 * Everything else (COMMERCIALS, FINDER_SCORE, DEALS, IMAGES, internal flags)
 * is either Finder-internal or not verifiable against the provider's website.
 */
const FACT_CHECK_GROUPS = new Set([
  "RATES",
  "FEES",
  "REQUIREMENTS",
  "DETAILS",
  "DESCRIPTIONS",
  "LINKS",
  "OFFER",
]);

/**
 * Field groups to populate when CREATING a new product/provider.
 * Only verifiable, data-driven fields — never editorial or internal.
 */
const CREATE_POPULATE_GROUPS = new Set([
  "RATES",
  "FEES",
  "REQUIREMENTS",
  "DETAILS",
  "LINKS",
]);

/**
 * Field groups to SKIP when creating — editorial, internal, or image fields.
 * These are written by editors, managed by Finder systems, or require FCC upload.
 */
const CREATE_SKIP_GROUPS = new Set([
  "DESCRIPTIONS",
  "DEALS",
  "COMMERCIALS",
  "FINDER_SCORE",
  "CUSTOMER_REVIEWS",
  "IMAGES",
  "OFFER",
  "CARDS",
]);

/**
 * Specific GENERAL.* fields to skip during creation — internal flags.
 */
const CREATE_SKIP_FIELDS = new Set([
  "GENERAL.HIDE_BEHIND_FULL_MARKET_CHECKBOX",
  "GENERAL.HIDE_LEAD_FORM_CTA",
  "GENERAL.HIDE_REDIRECT_CTA",
  "GENERAL.HIDE_REVIEW_CTA",
  "GENERAL.HOME_PAGE_TEXT",
  "GENERAL.INTERNAL_NOTES",
  "GENERAL.IS_SPONSORSHIP",
  "GENERAL.LEGACY_ID",
  "GENERAL.EXTERNAL_ID",
  "GENERAL.SPONSORED",
  "GENERAL.PROVIDER_NAME_CTA",
  "GENERAL.FINDER_AWARDS_WINNER",
  "GENERAL.FINDER_AWARDS_WINNER_TOOLTIP",
  "GENERAL.DEFAULT_VARIANT_ID",
  "GENERAL.NICKNAME",
  "GENERAL.TABLE_DESCRIPTION",
  "GENERAL.PRODUCT_MONITORED",
  "GENERAL.REVIEWABLE",
]);

/**
 * Specific fields to exclude even within verifiable groups.
 * Internal flags, Finder editorial, or non-provider data.
 */
const FACT_CHECK_EXCLUDE = new Set([
  "DETAILS.3PC_HEADING",
  "DETAILS.3PC_HEADING_OVERRIDE",
  "DETAILS.3PC_HEADING_PAID",
  "DETAILS.ALT_HEADER",
  "DETAILS.COMPLIANCE_PROVIDER_NAME",
  "DETAILS.DISCLAIMER",
  "DETAILS.DISCLAIMER_DROPDOWN_ENABLED",
  "DETAILS.DISPLAY_COMPLIANCE_AFF_DISCLAIMER",
  "DETAILS.EDITORIAL_DISCLAIMER_TOOLTIP",
  "DETAILS.FINDER_MENTIONS",
  "DETAILS.HEADER_1",
  "DETAILS.HEADER_2",
  "DETAILS.HEADER_3",
  "DETAILS.HEADER_4",
  "DETAILS.HEADER_5",
  "DETAILS.NATIONAL_AVERGE",
  "DETAILS.PDS_URL",
  "DETAILS.PROVIDER_DISCLAIMER",
  "DETAILS.STAR_RATING",
  "DETAILS.THREEPC_DISCLAIMER",
  "DETAILS.TIMES_NATIONAL_AVERAGE",
  "DETAILS.USE_HEADER_OVERRIDE",
  "DESCRIPTIONS.LOZENGE_TOOLTIP",
  "DESCRIPTIONS.RELATED_PRODUCT_1",
  "DESCRIPTIONS.RELATED_PRODUCT_2",
  "DESCRIPTIONS.RELATED_PRODUCT_3",
  "DESCRIPTIONS.RELATED_PRODUCT_4",
  "DESCRIPTIONS.RIBBON_TEXT",
  "DESCRIPTIONS.TOP_PICKS_BOTTOM_LABEL",
  "LINKS.BONUS_LINK",
  "LINKS.EXTERNAL_REDIRECT",
  "LINKS.PRODUCT_PAGE_URL",
  "LINKS.REDIRECT_SLUG",
  "FEES.BEST_CARDS_FREE_TOOGLE",
]);

server.registerTool(
  "fact_check_product",
  {
    title: "Fact Check Product",
    description: `Fetch a product's verifiable data fields for fact-checking against the provider's actual website. Accepts either a product_id directly, or a fuzzy search query to find the product first.

Returns only externally verifiable fields (rates, fees, requirements, features, descriptions) organized by category, with the provider's website URL as the primary verification source. Internal fields (IDs, commercials, Finder scores, images) are stripped.

After calling this tool, visit the provider's website URL and the product/terms URLs to verify each field value is current and accurate. Flag any discrepancies.

Examples:
  - fact_check_product(query: "TD checking", country_code: "us")
  - fact_check_product(niche_code: "USFSA", product_id: "8c42ea89-...")`,
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "Fuzzy search for product by name (e.g. 'TD checking', 'Chase savings'). Searches provider names then matches products.",
        ),
      country_code: z
        .string()
        .optional()
        .describe("Country code for search (required with query, e.g. 'us')"),
      niche_code: z
        .string()
        .optional()
        .describe(
          "Niche code if known (e.g. 'USFSA'). Required with product_id.",
        ),
      product_id: z
        .string()
        .optional()
        .describe("Product UUID if already known. Requires niche_code."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, country_code, niche_code, product_id }) => {
    // --- Resolve product ---
    let resolvedNiche = niche_code;
    let resolvedProductId = product_id;
    let searchContext: unknown = null;

    if (resolvedProductId && resolvedNiche) {
      // Direct lookup — skip search
    } else if (query && country_code) {
      // Fuzzy search: find providers matching query, then list their products
      const cc = country_code.toLowerCase();
      const { data: configs } = await supabase
        .from("pw_niche_configs")
        .select("niche_code")
        .eq("country_code", cc)
        .eq("status", "ready");

      if (!configs || configs.length === 0) {
        throw new Error(`No configured niches for country '${cc}'`);
      }

      // Search providers across all niches
      const providerResults = await Promise.allSettled(
        configs.map(async (c) => {
          const providers = await fetchNicheProviders(c.niche_code);
          return { niche_code: c.niche_code, providers };
        }),
      );

      // Find best provider match
      type ProviderMatch = {
        niche_code: string;
        provider_id: string;
        provider_name: string;
        score: number;
      };
      const providerMatches: ProviderMatch[] = [];
      for (const r of providerResults) {
        if (r.status !== "fulfilled") continue;
        for (const p of r.value.providers) {
          const score = fuzzyScore(p.name, query);
          if (score > 0) {
            providerMatches.push({
              niche_code: r.value.niche_code,
              provider_id: p.id,
              provider_name: p.name,
              score,
            });
          }
        }
      }

      if (providerMatches.length === 0) {
        // Try matching product names directly
        const productResults = await Promise.allSettled(
          configs.map(async (c) => {
            const products = await fetchNicheProducts(c.niche_code);
            return { niche_code: c.niche_code, products };
          }),
        );

        type ProductMatch = {
          niche_code: string;
          product_id: string;
          product_name: string;
          score: number;
        };
        const productMatches: ProductMatch[] = [];
        for (const r of productResults) {
          if (r.status !== "fulfilled") continue;
          for (const p of r.value.products) {
            const score = fuzzyScore(p.name, query);
            if (score > 0) {
              productMatches.push({
                niche_code: r.value.niche_code,
                product_id: p.id,
                product_name: p.name,
                score,
              });
            }
          }
        }

        if (productMatches.length === 0) {
          throw new Error(
            `No providers or products matching '${query}' found in ${cc.toUpperCase()}`,
          );
        }

        productMatches.sort((a, b) => b.score - a.score);
        resolvedNiche = productMatches[0].niche_code;
        resolvedProductId = productMatches[0].product_id;
        searchContext = {
          matched_by: "product_name",
          match: productMatches[0],
          other_matches: productMatches.slice(1, 5),
        };
      } else {
        // Found provider — now find their products and best match
        providerMatches.sort((a, b) => b.score - a.score);
        const bestProvider = providerMatches[0];

        const products = await fetchNicheProducts(
          bestProvider.niche_code,
          bestProvider.provider_id,
        );

        // Try to match product name from query
        let bestProduct = products[0]; // default to first
        let bestProductScore = 0;
        for (const p of products) {
          const score = fuzzyScore(p.name, query);
          if (score > bestProductScore) {
            bestProduct = p;
            bestProductScore = score;
          }
        }

        // If no product matched the query well, return all products for the user to pick
        if (bestProductScore === 0 && products.length > 1) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "multiple_products",
                    message: `Found provider '${bestProvider.provider_name}' but couldn't determine which product to fact-check. Please specify.`,
                    provider: bestProvider,
                    products: products.map((p) => ({
                      id: p.id,
                      name: p.name,
                      active: p.active,
                    })),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        resolvedNiche = bestProvider.niche_code;
        resolvedProductId = bestProduct.id;
        searchContext = {
          matched_by: "provider_then_product",
          provider: bestProvider,
          product: {
            id: bestProduct.id,
            name: bestProduct.name,
            score: bestProductScore,
          },
          other_products: products
            .filter((p) => p.id !== bestProduct.id)
            .map((p) => ({ id: p.id, name: p.name, active: p.active })),
        };
      }
    } else {
      throw new Error(
        "Provide either (query + country_code) for fuzzy search, or (niche_code + product_id) for direct lookup.",
      );
    }

    // --- Fetch product + provider ---
    const product = (await fetchPAPI(
      `/niches/${resolvedNiche}/data/products/${resolvedProductId}`,
    )) as { values?: Record<string, Record<string, unknown>> };

    const productValues = product.values ?? {};
    const providerId = (
      productValues["GENERAL.PROVIDER_ID"] as Record<string, string>
    )?.["en-US"];

    let providerValues: Record<string, Record<string, unknown>> = {};
    let providerWebsite: string | null = null;
    if (providerId) {
      const provider = (await fetchPAPI(
        `/niches/${resolvedNiche}/data/providers/${providerId}`,
      )) as { values?: Record<string, Record<string, unknown>> };
      providerValues = provider.values ?? {};
      providerWebsite =
        (providerValues["LINKS.URL"] as Record<string, string>)?.["en-US"] ??
        null;
    }

    // --- Filter to verifiable fields ---
    const verifiable: Record<string, Record<string, unknown>> = {};
    for (const [key, val] of Object.entries(productValues)) {
      const group = key.split(".")[0];
      if (!FACT_CHECK_GROUPS.has(group)) continue;
      if (FACT_CHECK_EXCLUDE.has(key)) continue;

      // Get the locale value
      const localeVal = Object.values(val as Record<string, unknown>)[0];
      if (localeVal === null || localeVal === "" || localeVal === undefined)
        continue;

      if (!verifiable[group]) verifiable[group] = {};
      verifiable[group][key] = localeVal;
    }

    // --- Detect hardcoded values in editorial text ---
    // Collect data values (rates, fees, amounts) that might be hardcoded
    // in DESCRIPTIONS.* fields instead of using template variables.
    const dataValues: Array<{
      field: string;
      value: string;
      pattern: RegExp;
      template: string;
    }> = [];
    const DATA_GROUPS_FOR_TEMPLATE = ["RATES", "FEES", "REQUIREMENTS"];
    for (const [key, val] of Object.entries(productValues)) {
      const group = key.split(".")[0];
      if (!DATA_GROUPS_FOR_TEMPLATE.includes(group)) continue;
      const localeVal = Object.values(val as Record<string, unknown>)[0];
      if (localeVal === null || localeVal === undefined) continue;
      const str = String(localeVal).trim();
      // Skip booleans, empty, long text
      if (str === "true" || str === "false" || str === "" || str.length > 20)
        continue;
      // Must contain at least one digit
      if (!/\d/.test(str)) continue;
      // Skip bare "0" — too common in text to be useful
      if (str === "0") continue;
      // Build regex with digit boundaries to avoid matching inside larger numbers
      // e.g. "15" matches "$15/month" but not "150" or "2015"
      const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<!\\d)${escaped}(?!\\d)`);
      dataValues.push({
        field: key,
        value: str,
        pattern,
        template: `{{product.${key}}}`,
      });
    }

    // Scan DESCRIPTIONS.* for hardcoded data values
    const templateIssues: Array<{
      editorial_field: string;
      hardcoded_value: string;
      data_field: string;
      suggested_template: string;
      context: string;
    }> = [];

    if (dataValues.length > 0) {
      for (const [key, val] of Object.entries(productValues)) {
        if (!key.startsWith("DESCRIPTIONS.")) continue;
        const localeVal = Object.values(
          val as Record<string, unknown>,
        )[0] as string;
        if (!localeVal || typeof localeVal !== "string") continue;

        for (const dv of dataValues) {
          const match = dv.pattern.exec(localeVal);
          if (!match) continue;

          // Extract surrounding context (30 chars each side)
          const idx = match.index;
          const start = Math.max(0, idx - 30);
          const end = Math.min(localeVal.length, idx + dv.value.length + 30);
          const context =
            (start > 0 ? "..." : "") +
            localeVal.slice(start, end) +
            (end < localeVal.length ? "..." : "");

          templateIssues.push({
            editorial_field: key,
            hardcoded_value: dv.value,
            data_field: dv.field,
            suggested_template: dv.template,
            context,
          });
        }
      }
    }

    // --- Build verification sources ---
    const sources: Record<string, unknown> = {};
    if (providerWebsite) sources.provider_website = providerWebsite;

    const termsUrl = (
      productValues["LINKS.TERMS_URL"] as Record<string, string>
    )?.["en-US"];
    if (termsUrl) sources.terms_url = termsUrl;

    const providerLanding = (
      productValues["LINKS.PROVIDER_LANDING_URL"] as Record<string, string>
    )?.["en-US"];
    if (providerLanding) sources.product_page = providerLanding;

    const versionista = (
      providerValues["LINKS.VERSIONISTA_URL"] as Record<string, string>
    )?.["en-US"];
    if (versionista) sources.versionista = versionista;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              product_name: (
                productValues["GENERAL.NAME"] as Record<string, string>
              )?.["en-US"],
              product_id: resolvedProductId,
              niche_code: resolvedNiche,
              provider_name: (
                providerValues["GENERAL.NAME"] as Record<string, string>
              )?.["en-US"],
              provider_id: providerId,
              active: (
                productValues["GENERAL.ACTIVE"] as Record<string, boolean>
              )?.["en-US"],
              verification_sources: sources,
              verifiable_fields: verifiable,
              field_count: Object.values(verifiable).reduce(
                (sum, g) => sum + Object.keys(g).length,
                0,
              ),
              ...(templateIssues.length > 0 && {
                template_issues: templateIssues,
                template_issues_note:
                  "These editorial fields contain hardcoded data values that should use template variables. When the data field changes, the editorial text will become stale. Fix by replacing the hardcoded value with the suggested template variable.",
              }),
              ...(searchContext && { search_context: searchContext }),
              instructions:
                "Visit the verification_sources URLs to check each field value. Focus on RATES and FEES first — these change most frequently. Flag any value that differs from the provider's current published data. Also review any template_issues — editorial text with hardcoded values that should reference data fields instead.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---- niche_builder_guide ----------------------------------------------------

server.registerTool(
  "niche_builder_guide",
  {
    title: "Niche Builder Guide",
    description:
      "Returns the complete workflow guide for creating providers and products using the Niche Builder tools. Call this first if you're unsure how to use the product/provider creation tools, or if a user asks to set up a new product or provider.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => ({
    content: [
      {
        type: "text",
        text: `# Niche Builder — Workflow Guide

## Overview

The Niche Builder tools let you create, update, and manage providers and products in Finder's Product API (PAPI). Each product belongs to a provider, and both exist within a "niche" (e.g. USFSA = US Savings Accounts, USCCF = US Credit Cards, AUFHI-NEW = AU Home Insurance).

## Key Concepts

- **Niche**: A product category scoped to a country (e.g. USFSA, USCCF). Each niche has its own field schema.
- **Provider**: A company/institution (e.g. "TD Bank", "Chase"). Providers can exist in multiple niches.
- **Product**: A specific offering from a provider (e.g. "TD Simple Savings"). Always belongs to one provider.
- **Values format**: All field values are locale-keyed objects: \`{ "GENERAL.NAME": { "en-US": "TD Bank" } }\`
- **Field groups**: Fields are organized in groups — GENERAL, RATES, FEES, DETAILS, IMAGES, LINKS, DESCRIPTIONS, REQUIREMENTS, etc. Each niche has different fields.

## Which Fields to Populate vs Skip

When creating a new product or provider, ONLY populate verifiable data fields and required fields. Leave editorial, internal, and image fields blank.

### POPULATE (verifiable + required):
- **GENERAL.NAME** (required) — product/provider name
- **GENERAL.ACTIVE** (required) — set true
- **GENERAL.PROVIDER_ID** (required for products) — provider UUID
- **GENERAL.PRODUCT_TYPE** (required for products) — usually "Default"
- **RATES.\\*** — APY, interest rates, compounding, rate dates
- **FEES.\\*** — monthly fees, ATM fees, wire fees, fee conditions
- **REQUIREMENTS.\\*** — minimum deposit, balance, age requirements
- **DETAILS.\\*** — account type, FDIC insurance, features, availability, online only
- **LINKS.PROVIDER_LANDING_URL** — URL to the product on the provider's site
- **LINKS.TERMS_URL** — URL to terms/fee schedule PDF

### SKIP (editorial / internal / images):
- **DESCRIPTIONS.\\*** — written by editors, not data. Leave blank.
- **DEALS.\\*** — Finder internal campaigns
- **COMMERCIALS.\\*** — EPC, CTR, modifier (ad metrics)
- **FINDER_SCORE.\\*** — Finder's internal rating
- **CUSTOMER_REVIEWS.\\*** — aggregated from external sites
- **IMAGES.\\*** — requires FCC admin upload, cannot be set via API
- **OFFER.\\*** — marketing offers managed by partnerships team
- **CARDS.\\*** — niche-specific, filled by editors
- **GENERAL.HIDE_\\***, **GENERAL.IS_SPONSORSHIP**, **GENERAL.SPONSORED** — internal display flags
- **GENERAL.LEGACY_ID**, **GENERAL.EXTERNAL_ID** — migration fields
- **GENERAL.INTERNAL_NOTES** — editorial

This keeps token usage efficient and avoids polluting editorial content. Editors will fill in DESCRIPTIONS, DEALS, IMAGES, etc. separately.

## Workflow: Creating a New Product

### Step 1: Identify the niche
Use \`list_niches\` with the country code to see available niches, or parse the niche code from the user's request (e.g. "USFSA" = US Savings Accounts).

### Step 2: Find or create the provider
Use \`search_providers\` to check if the provider already exists. If found, note the provider_id. If not found, create one with \`create_provider\`.

### Step 3: Understand the field structure
Use \`get_product\` on an EXISTING product in the same niche to see the full field set. This is critical — the schema endpoint only returns core fields, but real products have 100-200+ fields across many groups (RATES, FEES, DETAILS, etc.). Use an existing product as your reference. Only populate the groups listed in "Which Fields to Populate" above.

### Step 4: Research the product
Use web search to find current product details: rates, fees, features, requirements. Only research verifiable data from the provider's own website. Do NOT write marketing descriptions, pros/cons, or editorial content.

### Step 5: Find a logo
Search the web for a transparent PNG of the provider/product logo. Note the URL for manual upload. IMPORTANT: Logo images cannot be uploaded programmatically — they must be uploaded through Finder's admin interface (FCC).

### Step 6: Present draft for review
Before creating, show the user the values you plan to submit. Include:
- All populated fields with their values and sources
- The logo URL for manual FCC upload
- Any fields you're uncertain about

### Step 7: Create the product
Use \`create_product\` with the confirmed values. The response includes the new product ID.

### Step 8: Verify
Use \`get_product\` with the new ID to confirm everything was saved correctly.

## Workflow: Creating a New Provider

Same as above but simpler — providers have fewer fields (~30-40 vs 100-200 for products). Use \`get_provider\` on an existing provider in the same niche as your reference.

## PAPI Quirks

- **Required fields in updates**: PUT operations require GENERAL.NAME and GENERAL.PROVIDER_ID (for products) even if you're not changing them. Always include these.
- **Locale keys**: US niches use "en-US", AU uses "en-AU", UK uses "en-GB". Always match the niche's locale.
- **Numeric fields**: Must be numbers, not strings with symbols. Strip $, %, commas before submitting.
- **Boolean fields**: Use true/false, not strings.
- **Images**: IMAGES.LOGO, IMAGES.PRODUCT_IMAGE, IMAGES.TABLE_IMAGE use S3 paths. Cannot be set via API — must be uploaded through FCC admin.
- **Soft delete**: Set GENERAL.ACTIVE to false and GENERAL.DELETED to true. Or use delete_product/delete_provider for hard delete.
- **Audit trail**: All write operations are attributed to the user via the \`x-user-email\` header set in the MCP config. This appears in PAPI's event logs. The header is required — writes will fail without it.

## Available Tools (in typical order of use)

1. \`niche_builder_guide\` — This guide (you're reading it)
2. \`list_niches\` — See available niches for a country
3. \`search_providers\` — Find a provider across niches
4. \`list_niche_providers\` — List all providers in a niche
5. \`list_provider_products\` — List products from a provider
6. \`get_niche_schema\` — Get core field definitions
7. \`get_provider\` / \`get_product\` — Get full entity details (use as field template)
8. \`create_provider\` / \`create_product\` — Create new entities
9. \`update_provider\` / \`update_product\` — Update existing entities
10. \`delete_provider\` / \`delete_product\` — Delete entities (hard delete)
11. \`fact_check_product\` — Fetch verifiable fields for fact-checking against provider website

## Workflow: Fact-Checking a Product

### Step 1: Find the product
Use \`fact_check_product\` with a fuzzy query (e.g. "TD checking") and country code. It will search providers and products, find the best match, and return only the verifiable fields.

### Step 2: Review the verification sources
The tool returns provider website URL, terms URL, and product page URL. Visit these to compare against the stored data.

### Step 3: Check fields by priority
- **RATES** (APY, interest rates) — change most frequently, check first
- **FEES** (monthly fees, ATM fees, minimums) — change occasionally
- **REQUIREMENTS** (min deposit, balance, age) — relatively stable
- **DETAILS** (features, availability, account type) — check for accuracy

### Step 4: Check template issues
The tool also scans editorial fields (DESCRIPTIONS.*) for hardcoded data values that should use template variables. For example, if DESCRIPTIONS.HERO_CONTENT_DESCRIPTION says "earn up to 4.9% APY" and RATES.APY is 4.9, the text should use \`{{product.RATES.APY}}\` instead. These are returned in the template_issues section. Fix these — they cause editorial text to go stale when rates change.

### Step 5: Report discrepancies
For each field that differs from the provider's published data, note the field name, current PAPI value, correct value, and source URL. Also report any template issues found.

### Step 6: Update if authorized
Use \`update_product\` to fix incorrect data values AND template issues. For template fixes, update the DESCRIPTIONS field to replace the hardcoded value with the template variable. The tool handles read-merge-write automatically — just send the fields you want to change.`,
      },
    ],
  }),
);

// ---------------------------------------------------------------------------
// Request-scoped user identity for PAPI audit trail
// Set from x-user-email header on each request.
// ---------------------------------------------------------------------------

let currentUserEmail: string | null = null;

// ---------------------------------------------------------------------------
// HTTP handler — Streamable HTTP transport with API key auth
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://www.finderops.ai",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, x-api-key, x-user-email, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/datavis-mcp/, "");

  // Health check
  if (path === "/health" || path === "/health/") {
    return new Response(JSON.stringify({ status: "ok", tools: 27 }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // MCP endpoint — auth required
  if (path === "/mcp" || path === "/mcp/" || path === "" || path === "/") {
    // API key check — MCP_API_KEYS is comma-separated list of valid keys
    const apiKey = req.headers.get("x-api-key");
    const validKeys = (Deno.env.get("MCP_API_KEYS") ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    if (validKeys.length === 0) {
      console.error("MCP_API_KEYS is not configured — rejecting all requests");
      return new Response(JSON.stringify({ error: "Server misconfigured" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (!apiKey || !validKeys.includes(apiKey)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Capture user email for PAPI audit trail
    currentUserEmail = req.headers.get("x-user-email");

    try {
      // Stateless: new transport per request
      const transport = new WebStandardStreamableHTTPServerTransport();
      await server.connect(transport);
      const response = await transport.handleRequest(req);

      // Append CORS headers to the response
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        headers.set(k, v);
      }

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    } catch (err) {
      console.error("MCP handler error:", err);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Not Found", {
    status: 404,
    headers: CORS_HEADERS,
  });
});
