# Gateway ↔ engine protocol (v1)

How the gateway (`service/`, plain Node) talks to an engine. The engine code is the
headless export service (`src/js/headless/`). It runs under one of two hosts:

- **Bun** (default): `bun src/js/headless/cli.js engine --config <engine.json>`
- **NW.js** (WebGL-only job kinds): `wow.export.exe --user-data-dir=<dir> --disable-auto-update --export-service=<engine.json>`

## engine.json
```json
{
  "protocol": 1,
  "id": "wowf-quick",
  "gatewayPort": 51234,
  "secret": "<64 hex chars>",
  "source": { "type": "local", "install": "C:\\Program Files (x86)\\World of Warcraft", "product": "wowf", "region": "us" },
  "dataDir": "<root>/engines/wowf-quick",
  "config": { "exportConcurrency": 8 }
}
```
For a CDN build, `source` is `{ "type": "remote", "product": "wow", "region": "us" }`.

The engine connects to `127.0.0.1:<gatewayPort>` over TCP. Messages are UTF-8 JSON
objects, one per line (`\n`-terminated). Each has a `t` field, its type. **If the socket
closes, the engine exits**, so engines never outlive their gateway.

## Engine → gateway
| t | fields | when |
|---|---|---|
| `hello` | `secret, id, pid, protocol, host: "bun"\|"nw"` | first message; the gateway closes the socket if the secret is wrong |
| `ready` | `build: {product, version, buildConfig, fileCount}, loadMs, kinds: [...]` | game data open; `kinds` lists the job kinds this host supports |
| `fatal` | `error: {code, message}` | could not open the game data; the engine exits afterwards |
| `heartbeat` | `rss, heapUsed, job: id\|null, uptime` | every 5 s |
| `progress` | `job, done, total, current?` | while a job runs (at most about 4 per second) |
| `done` | `job, ok, cancelled, error?: {code, message}, result, failed: [{item, error}]` | job finished; `result` is the service operation's return value |
| `reply` | `req, ok, result?, error?: {code, message}` | answer to a `query` |

## Gateway → engine
| t | fields | meaning |
|---|---|---|
| `welcome` | `` | secret accepted |
| `job` | `job, kind, params, outDir` | run an export into `outDir`; the engine runs at most one job at a time and rejects a second one with `done` `BUSY` |
| `cancel` | `job` | cancel the running job; the engine answers with `done` and `cancelled: true` |
| `query` | `req, kind, params` | read-only operation; it may run while a job is running |
| `shutdown` | `` | exit cleanly |

Before every job the engine restores its configuration, so nothing leaks from one job
to the next. Every file is written under `outDir`; overwriting is on.

## Error codes
`INVALID_PARAMS`, `NOT_FOUND`, `NOT_ON_MAP`, `UNSUPPORTED`, `EXPORT_FAILED`,
`CANCELLED`, `BUSY`, `SOURCE_UNAVAILABLE`, `INTERNAL`.

`ok` is true only when every item succeeded. A job where some items failed is
`ok: false` with no `error` and a non-empty `failed`; the gateway reports it as
`partial`.

## Job kinds and queries
Job and query kinds are the headless service's operations, named as in
`src/js/headless/tools.js`. The params are the tool arguments, without
`outDir`/`product`, which come from the gateway.

- **Queries:** `info`, `search`, `list_maps`, `list_map_tiles`, `query_table`,
  `describe_table`, `list_tables`, `file_info`.
- **Jobs:** `get_file`, `export_files`, `export_textures`, `export_model`,
  `export_models`, `export_map`, `export_table`, and, on the NW host only,
  `export_map_baked`, `export_minimap`.
