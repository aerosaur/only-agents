# Only Agents

MCP server for [OnlyFinders](https://www.finderops.ai) — exposes the Data Visualizer as tools any MCP-compatible client can use.

Built as a [Supabase Edge Function](https://supabase.com/docs/guides/functions) using [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http).

## Tools

| Tool                   | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `list_workspaces`      | List available markets (US, UK, AU, CA, Global)             |
| `list_folders`         | List folders within a workspace                             |
| `list_charts`          | List charts in a workspace, optionally filtered by folder   |
| `get_chart`            | Get full chart data and config by ID                        |
| `fetch_sheet_tabs`     | List tabs from a Google Sheets URL                          |
| `fetch_sheet_data`     | Fetch row data from a specific sheet tab                    |
| `create_chart`         | Create a new chart with data and config                     |
| `update_chart`         | Update an existing chart's data, config, or type            |
| `set_chart_visibility` | Toggle a chart between public and private                   |
| `get_embed_code`       | Get WordPress shortcode and iframe embed for a public chart |

## Setup

### Claude Code (CLI)

```bash
claude mcp add -t http \
  -H "x-api-key: YOUR_API_KEY" \
  -s user only-agents \
  https://rlrermiuwqzliihkxyhj.supabase.co/functions/v1/datavis-mcp/mcp
```

Restart Claude Code after adding. The 10 tools will show up automatically.

### Other MCP clients

Any client that supports Streamable HTTP transport can connect to:

```
POST https://rlrermiuwqzliihkxyhj.supabase.co/functions/v1/datavis-mcp/mcp
```

Auth via `x-api-key` header.

## Auth

Each user gets their own API key. DM [@michael.bowley](https://finder.slack.com/team/U1GTULGP6) on Slack to get one.

## Project structure

```
supabase/
  functions/
    datavis-mcp/
      index.ts    # MCP server — all tools and HTTP handler
```

## Development

Deploy with the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
npx supabase functions deploy datavis-mcp --project-ref rlrermiuwqzliihkxyhj
```

Health check:

```bash
curl https://rlrermiuwqzliihkxyhj.supabase.co/functions/v1/datavis-mcp/health
# {"status":"ok","tools":10}
```
