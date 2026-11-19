# Gateway ↔ engine protocol (v1)

How the gateway (`service/`, plain Node) talks to an engine (headless wow.export,
`src/js/export-service/`).

## Starting an engine
The gateway starts the app like this:

```
wow.export.exe --user-data-dir=<root>/engines/<lane>/appdata --disable-auto-update --export-service=<root>/engines/<lane>/engine.json
```

`engine.json` contains:
```json
{
  "protocol": 1,
  "lane": "quick" | "bulk",
  "gatewayPort": 51234,
  "secret": "<64 hex chars>",
  "install": "C:\\Program Files (x86)\\World of Warcraft",
  "product": "wow" ,
  "region": "us",
  "workDir": "<root>/engines/<lane>",
  "baseConfig": { "exportConcurrency": 8, "...": "any core.view.config keys" }
}
```
The engine connects to `127.0.0.1:<gatewayPort>` over TCP. Messages are UTF-8 JSON
objects, one per line (`\n`-terminated). Each has a `t` field, its type.

## Engine → gateway
| t | fields | when |
|---|---|---|
| `hello` | `secret, lane, pid, protocol` | first message; the gateway closes the socket if the secret is wrong |
| `state` | `state: "loading"\|"ready"\|"error", message?` | load progress or failure |
| `ready` | `build: {version, buildKey, product}, listfile: {path, count}, loadMs` | CASC loaded; `listfile.path` is a TSV file the engine wrote in `workDir` (`<fileDataID>\t<path>` per line, lowercase paths) |
| `heartbeat` | `rss, heapUsed, job: id\|null, uptime` | every 5 s |
| `progress` | `job, done, total, current?` | while a job runs (rate-limited to about 4 per second) |
| `done` | `job, ok, cancelled, error?: {code, message}, items: {total, succeeded, failed: [{item, error}]}, stats: {ms, ...}` | job finished |
| `reply` | `req, ok, result? , error?: {code, message}` | answer to a `query` |

## Gateway → engine
| t | fields | meaning |
|---|---|---|
| `welcome` | `` | secret accepted |
| `job` | `job, kind, params, outDir` | run an export; the engine runs at most one job at a time |
| `cancel` | `job` | cancel the running job; the engine answers with `done` and `cancelled: true` |
| `query` | `req, kind, params` | read-only lookup; it may run while a job is running |
| `shutdown` | `` | exit cleanly |

**Before every job** the engine restores the config it had right after loading, then
applies `baseConfig`, then the job's own settings. It sets
`exportDirectory = outDir` and `overwriteFiles = true`. Every file must be written under
`outDir`.

## Error codes
`INVALID_PARAMS`, `NOT_FOUND`, `NOT_ON_MAP`, `UNSUPPORTED`, `EXPORT_FAILED`,
`CANCELLED`, `BUSY`, `INTERNAL`.

`ok` is true only when every item succeeded. A job where some items failed is
`ok: false` with no `error` and a non-empty `items.failed`; the gateway reports it as
`partial`.

## Job kinds (`params` are already validated and normalised by the gateway)
In `files`, each entry is a fileDataID (number) or a listfile path (string,
case-insensitive). The engine reports items it can't resolve as failed with `NOT_FOUND`.

| kind | params |
|---|---|
| `map_tiles` | `map` (ID or directory), `tiles` (tile spec: list of `"Y_X"`, `{from,to}` or `"all"`), `format: "OBJ"\|"RAW"\|"HEIGHTMAP"`, `quality` (int, OBJ only; 0 = none, -1 = alpha maps, >0 = baked size), `include: {m2, wmo, wmoSets, foliage, liquid, holes, gameObjects}`, `splitAlphaMaps`, `heightmap: {resolution, bitDepth}` |
| `map_wmo` | `map` — exports the global WMO of a WMO-only map |
| `minimap` | `map, tiles` — minimap tiles as PNG |
| `model` | `files, format: "OBJ"\|"STL"\|"GLTF"\|"GLB"\|"RAW", textures, alpha, collision, animations, uv2, splitWMOGroups, meta, raw: {skin, skel, bone, anim, wmoGroups}` |
| `texture` | `files, format: "PNG"\|"WEBP"\|"BLP", channelMask, webpQuality, blpMeta` |
| `db2` | `tables, format: "CSV"\|"SQL"\|"DB2", sqlCreateTable` |
| `raw` | `files, kind: "raw"\|"audio"\|"font"\|"text"` — files written as stored; audio with an unknown extension is sniffed to `.ogg`/`.mp3` |
| `install_files` | `names?, tags?` |

## Query kinds
| kind | params | result |
|---|---|---|
| `list_maps` | `` | `[{id, directory, name, wdtFileDataID, tileCount, wmoOnly}]` |
| `map_tiles` | `map` | `{map, tiles: ["Y_X", ...]}` (terrain tiles only, flag 1) |
| `file_info` | `files` | `[{input, fileDataID, path, inBuild, size?}]` |
| `list_db2_tables` | `` | `[name, ...]` |
| `describe_db2` | `table` | `{table, columns: [{name, type}], rowCount}` |
| `query_db2` | `table, ids?, where?: {field: value}, offset, limit` | `{rows, total}` |
