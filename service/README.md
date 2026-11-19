# wow-export service

An always-on export service that lets Claude Code agents ask for World of Warcraft
exports over MCP and download the results. It covers agents on this PC and Claude Code
cloud sessions.

```
 agents ──MCP over HTTPS──► gateway (this folder, plain Node)
                              │  tokens, job queue, result cache, downloads
                              ▼
                            engines (src/js/headless, Bun), one per product and lane,
                            with the game data loaded once and kept warm
```

- The **gateway** listens on `127.0.0.1:8787`. Cloud sessions reach it through
  Tailscale Funnel.
- **Engines** are the headless exporter from `src/js/headless/`, started as child
  processes. They speak [PROTOCOL.md](PROTOCOL.md).
- **Default game data:** WoW Forever (`wowf`) from the local install. Other products
  (`wow`, `wow_classic`, …) come from Blizzard's CDN and start on first use.
- **Everything lives under `~/wow.export-service`:** settings, tokens, the job log,
  cached results and engine data. The service refuses to run if that folder overlaps
  your normal wow.export folders.

## Running it

```powershell
cd service
npm install
node cli.js token add my-agent   # prints a token once: keep it as WOW_EXPORT_TOKEN
node cli.js start
```

Settings go in `~/wow.export-service/service.json`; the defaults are in
`src/config.js`. The common ones:

| Setting | Default | Meaning |
|---|---|---|
| `port` | `8787` | Local port. |
| `publicUrl` | `null` | The Funnel URL, e.g. `https://pc.tailnet.ts.net`, used for download links in tunnelled requests. |
| `defaultProduct` | `wowf` | Product used when a request doesn't name one. |
| `sources` | `wowf` from `C:\Program Files (x86)\World of Warcraft` | Products opened from local installs. |
| `warmProducts` | `["wowf"]` | Products whose quick and bulk engines are always running. |
| `diskBudgetGB` / `minFreeGB` | `75` / `50` | Cache size limit, and the free-space floor below which jobs are refused. |
| `retentionDays` | `14` | Results unused for this long are deleted. |

## Connecting agents

On this PC:
```powershell
claude mcp add --transport http wow-export http://localhost:8787/mcp --header "Authorization: Bearer <token>"
```

In a Claude Code cloud session, commit this `.mcp.json` to the repository the session
works in:
```json
{ "mcpServers": { "wow-export": { "type": "http",
    "url": "https://<pc>.<tailnet>.ts.net/mcp",
    "headers": { "Authorization": "Bearer ${WOW_EXPORT_TOKEN}" } } } }
```

Then, in the cloud environment's settings:
- set `WOW_EXPORT_TOKEN` under Environment variables;
- set Network access to Limited, and add `<pc>.<tailnet>.ts.net` to Allowed domains.

## Tools

The server's MCP instructions explain the workflow to agents: find, export, wait, then
download.

- **Find:** `search`, `file_info`, `list_maps`, `list_map_tiles`, `list_tables`,
  `describe_table`, `query_table`, `info`, `service_status`.
- **Export:** `get_file`, `export_files`, `export_textures`, `export_model`,
  `export_models`, `export_map`, `export_table`. Each export becomes a job. The call
  waits up to 40 s, so small exports come back finished.
- **Jobs:** `wait_for_job`, `get_job`, `get_manifest`, `get_download_script`,
  `cancel_job`, `list_jobs`.

Every export takes `product`, `force` (skip the cache), `wait`, `label` and `priority`.

## HTTP routes

All routes except `/health` need `Authorization: Bearer <token>`.

| Route | |
|---|---|
| `GET /health` | `{"ok":true}` |
| `POST /mcp` | MCP (Streamable HTTP, stateless) |
| `GET /files/<key>/<path>` | one file; supports `Range`; the `X-Content-SHA256` header carries its hash |
| `GET /zip/<key>` | the whole result as a zip stream |
| `GET /manifest/<key>` | manifest JSON (paths, sizes, SHA-256) |
| `GET /list/<key>?format=curl\|sha256sum\|tsv` | file lists used by the download scripts |

## How results are reused

The cache key covers:
- the tool and its normalised parameters (file lists sorted, names lowercased);
- the product;
- the game build;
- a hash of the exporter source (`src/`);
- the engine settings.

A repeated request returns the stored result straight away. Identical requests that
arrive while one is running share that job. Partial results (some items failed) can be
downloaded but are never reused.

## Tests

```powershell
cd service
npm test
```

They use a fake engine (`test/fake-engine.js`) and cover:
- the MCP tools, caching and request sharing;
- lanes and cancellation;
- downloads, zips and Range requests;
- token handling, Host checks and path-escape attempts;
- engine crashes and hangs, sources that can't be opened;
- gateway restarts with queued and running jobs;
- build changes, quotas and eviction.
