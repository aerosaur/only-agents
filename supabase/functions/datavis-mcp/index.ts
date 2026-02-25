/**
 * OnlyFinders Data Visualizer MCP Server
 *
 * Supabase Edge Function exposing Data Visualizer operations as MCP tools.
 * Uses Streamable HTTP transport — clients connect via URL, not stdio.
 *
 * Endpoint: POST /datavis-mcp/mcp
 * Auth: x-api-key header checked against MCP_API_KEY secret
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
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "onlyfinders-datavis",
  version: "1.0.0",
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
    return new Response(JSON.stringify({ status: "ok", tools: 10 }), {
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
