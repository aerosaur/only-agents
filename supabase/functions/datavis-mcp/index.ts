/**
 * OnlyFinders MCP Server (Only Agents)
 *
 * Supabase Edge Function exposing OnlyFinders tools as MCP operations.
 * Uses Streamable HTTP transport — clients connect via URL, not stdio.
 *
 * Tool domains:
 *   - Data Visualizer: chart CRUD, Google Sheets import, embedding
 *   - Product Watchtower: provider/product search, watchlist management
 *
 * Endpoint: POST /datavis-mcp/mcp
 * Auth: x-api-key header checked against MCP_API_KEYS secret
 *
 * Required secrets:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Supabase access
 *   MCP_API_KEYS — comma-separated API keys for MCP auth
 *   GSHEET_WEBHOOK_URL, GSHEET_API_KEY — Google Sheets import (Data Viz)
 *   PRODUCT_API_USERNAME, PRODUCT_API_KEY — Finder Product API (Watchtower)
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
] as const;

const EMBED_BASE_URL = "https://www.only-finders.com";

// ---------------------------------------------------------------------------
// Product API (PAPI) — used by Watchtower tools
// ---------------------------------------------------------------------------

const PAPI_BASE = "https://product.api.production-02.fndr.systems/api/v117";
const PAPI_USERNAME = Deno.env.get("PRODUCT_API_USERNAME") ?? "";
const PAPI_KEY = Deno.env.get("PRODUCT_API_KEY") ?? "";

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
  version: "2.0.0",
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

// ---------------------------------------------------------------------------
// HTTP handler — Streamable HTTP transport with API key auth
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://www.only-finders.com",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, x-api-key, mcp-session-id, Last-Event-ID, mcp-protocol-version",
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
    return new Response(JSON.stringify({ status: "ok", tools: 16 }), {
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
