# wow.export export service: plan

Goal: Claude Code agents, both on this PC and in Claude Code cloud sessions, can ask
for any wow.export export with their own parameters and get the files back. Requests
must be fast, efficient and free of errors. This PC stays on and does the processing.

Status: approved. Work happens on branch `export-service`.

## Revision 2 (2026-11-18, evening): build on the existing headless MCP

`origin/main` already has a headless exporter, `src/js/headless/`, written by another
Claude session:
- It runs on Bun, with no NW.js.
- It has a stdio MCP server (`wow-export` in `.mcp.json`), a CLI, and `service.js`
  with these operations: search, get_file, export_textures, export_model, list_maps,
  list_map_tiles, export_map and query_table.

The user chose to build on it rather than alongside it, and to choose game data per
request. What changes from the plan below:

1. **The engine is the headless service, run as a child process.**
   - It runs as `bun src/js/headless/cli.js engine --config <engine.json>`, speaking
     `service/PROTOCOL.md`.
   - Its operations are extended to cover every export kind that doesn't need WebGL.
   - Its stdio MCP and CLI keep working for agents on this PC, using the same code.
2. **Game data per request.**
   - `product` is an optional parameter on every tool. The default is `wowf`, opened
     from the local install `C:\Program Files (x86)\World of Warcraft` (the same data as
     the user's workstream), with the CDN as fallback.
   - Any other product (`wow`, `wow_classic`, …) is opened from the CDN.
   - The runtime gains `openLocal(install, product)` next to `openRemote`.
   - Engines are keyed by product and lane:
     - The default product keeps a quick engine and a bulk engine warm all the time.
     - Other products start one engine on first use and stop it after 30 minutes idle.
3. **A WebGL host for what Bun can't do.**
   - These exports need a browser: baked terrain textures, minimap and WMO-minimap
     compositing, and game objects on tiles.
   - They run in the same engine code hosted inside headless wow.export (NW.js), started
     with `--export-service=<engine.json>`.
   - The gateway sends only those job kinds to it.
   - This is a later phase. The Bun engine covers everything else first.
4. **Data folders.** Each engine gets its own data dir under
   `C:\Users\colin\wow.export-service\engines\<product>-<lane>\`.
5. **Nothing else changes:** the gateway, the queue, the cache, the downloads, auth,
   Funnel and the QA plan are as below. Where sections 1 and 3 describe NW.js-only
   engines, this revision replaces them.

---

## 1. Architecture

```
 Claude Code agents                                   This PC (always on)
┌────────────────────┐                     ┌──────────────────────────────────────────────┐
│ local agents       │ http://localhost    │  GATEWAY  (plain Node, service/)             │
│                    │────────────────────►│   • MCP endpoint  POST/GET /mcp              │
│ cloud sessions     │ https://<pc>.ts.net │   • file downloads GET /files/... /zip/...   │
│                    │──── Tailscale ─────►│   • auth (bearer tokens), quotas             │
└────────────────────┘     Funnel          │   • job queue, result cache, retention       │
                                           │   • supervises the engine                    │
                                           │   • listfile index (search never blocks)     │
                                           │        │ 127.0.0.1 + shared secret            │
                                           │   ┌────┴─────────────────┐                   │
                                           │   ▼                      ▼                   │
                                           │  QUICK ENGINE          BULK ENGINE           │
                                           │  small jobs +          big jobs (tile        │
                                           │  DB2 queries           ranges, big batches)  │
                                           │  (headless wow.export, NW.js, CASC loaded     │
                                           │   once; each has its own data dir + cache)   │
                                           └──────────────────────────────────────────────┘
```

**Why two engines?** With only one engine, a request for a single texture could wait
four minutes behind a 336-tile export. So jobs go to one of two lanes:

- **Quick lane:** small jobs, up to 4 tiles or 25 files, plus DB2 queries. Target: a
  quick job never waits behind a bulk job.
- **Bulk lane:** everything else.

Each engine has its own data dir and CASC cache. That costs some disk and duplicates CDN
downloads, but avoids two processes writing one cache, the cause of the empty-cache bug
fixed earlier. Memory is about 3 GB per engine, out of 31 GB. Each lane runs one job at
a time, with parallel work inside the job.

If one engine is down, the other takes its jobs until it's back.

The gateway runs both engines below normal process priority, and caps tile concurrency,
so your own wow.export stays responsive.

**Where discovery is answered:**
- **In the gateway:** file search uses a listfile snapshot that the engine hands over
  after loading. It's held in gateway memory, so search works while engines are busy or
  restarting. Map and tile lists are cached the same way.
- **In the quick engine:** DB2 description and queries.

Search is substring or glob only, with no user regex, and has a time limit.

**Why two processes?**
- The engine has to be NW.js: tile baking needs WebGL, and textures and zones need a
  canvas.
- NW.js is also the part most likely to crash: GL, native memory, very large exports.
- The gateway is small, plain Node and stable. It holds the queue, the cache and the MCP
  sessions. If the engine dies, the gateway restarts it, re-runs or fails the job it was
  running cleanly, and agents keep their connection.

**Why HTTP MCP rather than stdio?** A single endpoint serves local agents
(`http://localhost:8787/mcp`) and cloud sessions (the public Funnel URL). It uses the
Streamable HTTP transport from the official SDK (`@modelcontextprotocol/sdk`).

**Why Tailscale Funnel rather than a Cloudflare Tunnel?** It's easier:
- No domain to buy or configure.
- One install, one sign-in, one command (`tailscale funnel --bg 8787`).
- A permanent HTTPS URL, `https://<pc-name>.<tailnet>.ts.net`, with no open router
  ports.

The trade-off is that Tailscale applies bandwidth limits to Funnel traffic that you
can't configure, so multi-GB downloads to cloud sessions will be slower than on a LAN.
Phase 8 measures the actual throughput. Nothing in the design depends on the tunnel: the
gateway only listens on localhost, so switching to a Cloudflare Tunnel later is just a
config change.

### Request lifecycle
1. An agent calls an `export_*` tool. The gateway validates the parameters with a zod
   schema and normalises them.
2. The cache key is
   `sha256(tool + normalised params + game build + engine code hash + baseline config hash)`.
   The engine code hash covers `src/`, so results exported before a code change are
   never served afterwards. Every export tool also takes `force: true` to skip the
   cache, and the integration tests always use it.
3. **Cache hit:** the gateway returns the finished job straight away, with its manifest
   and download links.
4. **Identical job already queued or running:** the agent joins that job instead of
   starting a second export (single-flight).
5. **Otherwise** the gateway queues a new job and returns `{ job_id, status: "queued",
   position }`.
6. The agent calls `wait_for_job(job_id)`. Each call waits up to about 50 seconds, under
   MCP client timeouts, and returns progress. Small exports finish within the first
   wait.
7. The engine exports into `staging/<job_id>/`. On success the gateway walks the folder
   and builds the manifest (path, size, sha256, type). It then renames the folder
   atomically to `results/<key>/` and writes `manifest.json`.
8. The agent downloads the files:
   - one at a time: `GET /files/<key>/<path>`
   - everything: `GET /zip/<key>`, a streamed zip
   - local agents can read `local_path` directly.

### Directory layout (all outside the prod `C:\Users\colin\wow.export`)
```
C:\Users\colin\wow.export-service\
  appdata\          engine's NW.js user-data-dir (own config, CASC cache, runtime.log)
  staging\<job>\    in-progress exports (deleted on failure)
  results\<key>\    finished exports + manifest.json (cache)
  jobs.sqlite|jsonl job records (survive restarts)
  tokens.json       agent tokens (hashed)
  service.json      settings: port, install path, product, disk budget, retention
  logs\             gateway.log, engine restarts
```
The existing export-test guard is kept and extended. Both the engine and the gateway
refuse to start if any of these folders is inside, or equal to, the prod export folder,
data folder or cache.

---

## 2. MCP tools

All tools return structured JSON and a short text summary. Errors use one shape:
`{ error: { code, message, hint, retryable } }`.

The codes are: `INVALID_PARAMS`, `NOT_FOUND`, `NOT_ON_MAP`, `UNSUPPORTED`,
`ENGINE_UNAVAILABLE`, `QUEUE_FULL`, `QUOTA_EXCEEDED`, `CANCELLED`, `EXPORT_FAILED`,
`TIMEOUT`.

**Discovery (fast, served from memory)**
| Tool | Purpose |
|---|---|
| `service_status` | build, product, engine state, queue depth, cache size, disk free, version |
| `search_files` | listfile search by substring/glob/regex + extension filter, paged; returns `{fileDataID, path, type}` |
| `get_file_info` | resolve path ↔ fileDataID, type, size, whether it exists in this build |
| `list_maps` | maps from db2.Map: id, directory, name, tile count, WMO-only flag |
| `get_map_tiles` | terrain tiles for a map (flag 1 only), optional bounding box |
| `list_db2_tables` | table names (from DBD manifest) |
| `describe_db2_table` | columns + types + row count, sample rows |
| `query_db2` | rows by ID / simple field filter, paged (returns JSON, no export needed) |
| `search_creatures` / `search_items` / `search_decor` | name search → display IDs / fileDataIDs (phase 2) |

**Exports (all return a job)**
| Tool | Parameters (main ones) |
|---|---|
| `export_map_tiles` | map, tiles (list / range / bbox / "all"), format OBJ/RAW/heightmap, quality, include M2/WMO/WMO sets/foliage/liquid/holes/gameobjects, split alpha maps |
| `export_map_wmo` | map (WMO-only maps) |
| `export_minimap` | map, tiles, as PNG tiles or stitched |
| `export_model` | fileDataIDs or paths (M2/M3/WMO), format OBJ/STL/GLTF/GLB/RAW, textures, alpha, collision, animations, UV2, WMO groups split, meta JSON, skin/variant index |
| `export_texture` | fileDataIDs or paths, format PNG/WEBP/BLP, channel mask, webp quality |
| `export_db2` | table names, format CSV/SQL/DB2, create-table |
| `export_raw` | fileDataIDs or paths, written as-is |
| `export_audio` / `export_font` / `export_text` | fileDataIDs or paths (audio auto-detects ogg/mp3) |
| `export_install_files` | install manifest tags / names |
| `export_creature` / `export_item` / `export_decor` | IDs → models + textures (phase 2) |
| `export_zone_map` | UiMap ID, phase (phase 3) |
| `export_video` | AVI/MP3/subtitles (MP4 needs external Kino service, phase 3) |

Every export also takes `priority` (`normal` or `low`) and `label` (free text that shows
up in `list_jobs`).

**Jobs**
| Tool | Purpose |
|---|---|
| `wait_for_job` | long-poll ≤ 45 s (cloud MCP requests must send a first byte within 60 s); returns status, progress (done/total, current item), and on completion the manifest summary + download info |
| `get_job` | non-blocking status |
| `get_manifest` | full file list (paged for big jobs): path, size, sha256, type, url, local_path |
| `get_download_script` | bash (and PowerShell) script that downloads every file with curl and verifies sha256; agents just run it |
| `cancel_job` | cancel (only affects that job; joined requests are told) |
| `list_jobs` | this token's recent jobs |

Characters (the `tab_characters` export) are **out of scope** for now. That export
reproduces whatever is in the live 3D preview, so it would need the whole customisation
state machine rebuilt. I'll scope it separately if you want it.

---

## 3. Engine design

- **Entry point:** `--export-service=<service.json>` in `src/app.js`, next to
  `--export-test`. It loads CASC once, preloads the listfile, the DBD manifest and
  `db2.Map`, then connects to the gateway on 127.0.0.1 with a shared secret.
- **Job protocol:** the gateway sends `{job_id, kind, params, out_dir}`. The engine
  sends back progress events and a final `{ok, error?, stats}`. Messages are
  newline-delimited JSON over a single local socket.
- **Settings for each job:** before every job the engine restores a baseline config
  snapshot, then applies that job's settings. No setting leaks from one job into the
  next.
- **One job at a time** in the engine. Parallel work happens inside the job (tile and
  model concurrency, the worker pool). This avoids races on global state (config,
  `exportCancelled`, the shared texture caches), the main risk with several agents.
- **Handlers:** one module per export kind under `src/js/export-service/handlers/`. Each
  calls the low-level exporters directly, the way the export test runner does. The
  needed private functions get extracted from the tabs into shared modules, with the
  tabs then calling the shared version so there is only one copy. The tabs that need
  this:
  - `tab_data`: `parse_table`
  - the raw, audio, font and text exports
  - `tab_maps`: the WMO, minimap and heightmap helpers
  - `tab_zones`: the render functions
- **Cancellation:** a per-job token, checked between files and tiles. The existing
  `core.view.exportCancelled` is wired to it.
- **Health:** a heartbeat every 5 s. The gateway restarts the engine after 3 missed
  heartbeats, after a crash, or when memory exceeds the limit (default 12 GB). After
  N jobs or 6 hours, it does a planned recycle while idle, to clear slow leaks.
- **Game updates:** on start and every 6 h, the engine checks whether the local install's
  build changed. If it did, it reloads. The cache key includes the build, so old
  results stop matching on their own.

## 4. Gateway design

- **Location:** `service/` with its own `package.json`, dependencies `@modelcontextprotocol/sdk`,
  `zod` and `archiver` (for the streamed zip). It is kept out of `build.json`, so the
  app build is unaffected. It runs on the system Node (v24).
- **MCP transport:** stateless mode, so a gateway restart never breaks an agent's
  session. Default page sizes stay small because MCP tool output is capped.
- **Auth:**
  - Every route needs a bearer token, compared in constant time. That includes requests
    from 127.0.0.1: Funnel traffic also arrives from localhost, so being local earns no
    trust. For the same reason, rate limits are per token, not per IP.
  - Download scripts read the token from `$WOW_EXPORT_TOKEN` and never embed it.
  - Tokens are stored hashed, one per agent or group, created with
    `node service/cli.js token add <name>`.
  - `/health` without a token returns only `ok`.
- **Paths:** download paths are resolved and checked against `results/<key>`, which
  rejects `..`, absolute paths, symlinks and odd encodings.
- **Limits for each token:**
  - queued jobs: 10
  - jobs running: 1
  - size of a single job: tiles ≤ 1,024, files ≤ 20,000 (configurable)
  - a request rate limit
- **Queue:** first in, first out with priority. A low-priority job never starts ahead of
  a normal one. The queue is persisted, so jobs survive a gateway restart.
- **Retention:** results expire 14 days after last access. Least recently used results
  are evicted to stay under the disk budget, 75 GB as you chose (test exports count toward
  it). The gateway also stops accepting jobs when free disk drops below 50 GB.
- **Logs:** structured logs and per-job timing (queue wait, export time, files, bytes),
  shown in `service_status`.
- **Single instance:** a lock file plus the fixed port.

## 5. Running it

- **Start at login:** `service/install.ps1` registers a per-user Windows Scheduled Task
  that runs the gateway at logon and restarts it on failure. No admin rights are
  needed. It runs at logon, not as a Windows service, because NW.js needs your desktop
  session for WebGL. If Windows refuses to register a logon-triggered task without
  admin rights, the script falls back to a shortcut in the per-user Startup folder,
  plus a small watchdog that restarts the gateway.
- **Tunnel:** `tailscale funnel --bg 8787`. The `--bg` setting is saved by Tailscale, but
  phase 6 confirms that it survives a Tailscale restart before relying on it.
- **Connecting agents:**
  - **On this PC:**
    `claude mcp add --transport http wow-export http://localhost:8787/mcp --header "Authorization: Bearer <token>"`
  - **In cloud sessions:** commit a `.mcp.json` to the repos they use:
    ```json
    { "mcpServers": { "wow-export": { "type": "http",
        "url": "https://<pc>.<tailnet>.ts.net/mcp",
        "headers": { "Authorization": "Bearer ${WOW_EXPORT_TOKEN}" } } } }
    ```
    Then, in the cloud environment's settings:
    - Set `WOW_EXPORT_TOKEN` under **Environment variables**. Values are read when the
      session starts.
    - Set **Network access** to **Limited** and add the exact host
      `<pc>.<tailnet>.ts.net` to **Allowed domains**.

    Notes from the Claude Code docs (checked 2026-11-18):
    - `.mcp.json` is loaded only in cloud sessions with a single repository. Servers you
      add on this PC with `claude mcp add` do not carry over.
    - `${VAR}` expansion works in `headers`.
    - Cloud traffic goes through Anthropic's security proxy.
    - Each MCP HTTP request must send its first byte within 60 s, so `wait_for_job`
      waits 45 s at most.
    - An HTTP response body is capped at 16 MiB.

    Alternative: the environment's network secrets can attach the
    `Authorization: Bearer` header in the proxy, so the token never enters the VM. Phase
    8 tests whether that works for MCP traffic.
- **Docs:** `service/README.md` covers setup, tokens, the tools and troubleshooting.
  There is also an agent-facing usage guide, which the server returns as its MCP
  `instructions` so agents know the workflow without being told.

---

## 6. Phases and acceptance

Each phase ends with its tests green and a commit on `export-service`.

| # | Phase | Done when |
|---|---|---|
| 0 | Branch, skeleton, plan committed | `service/` scaffolding, `npm test` runs |
| 1 | Engine host mode + job protocol | engine starts headless, loads CASC once, runs a tile job sent over the socket, heartbeats, cancels |
| 2 | Gateway core: auth, queue, staging→results, manifest, cache, single-flight, downloads, zip | fake-engine tests all pass (see QA) |
| 3 | MCP layer: discovery + job tools, error shape, instructions | MCP client tests against fake engine pass |
| 4 | Phase-1 exports: map tiles (OBJ/RAW/heightmap), WMO maps, minimap, models (all formats), textures, DB2, raw/audio/font/text, install files | each handler has an integration test against the real install; outputs validated |
| 5 | Supervision: crash restart, memory recycle, build-change reload, persisted queue | kill/restart tests pass |
| 6 | Startup + tunnel: scheduled task, Funnel, token tooling | `curl https://<pc>.ts.net/health` ok from outside; reboot-free restart test |
| 7 | Phase-2 exports: creatures (standard), items, decor; zone maps; videos (AVI/MP3/subs) | integration tests pass |
| 8 | Remote QA from a real cloud session | cloud agent requests, downloads, verifies hashes |
| 9 | Soak + report | overnight soak passes; `docs/export-service-report.md` written |

Character-model creatures (those with `extendedDisplayInfoID`), characters, and MP4
video come after this list. Each gets its own task.

**Realistic overnight scope.** Ten phases plus a 4-hour soak probably won't all finish in
one night, so the order of priority is:

1. One export working end to end through MCP on localhost: the engine, the gateway,
   the tools, and download links. This is phases 0 to 3 with a single handler.
2. The rest of the phase-1 exports (phase 4).
3. Supervision and recovery (phase 5).
4. Security tests, then Funnel and startup (phase 6).
5. Phases 7 to 9.

Whatever isn't finished is listed in the progress log for the next session.

**Progress log.** `docs/export-service-progress.md` is updated at the end of every phase.
It records what's done, what's next, test status and open issues, so the work survives
restarts and context resets.

**Funnel goes live only after the security tests pass.** That means the auth tests
(missing, wrong and revoked tokens) and the path-safety tests must all be green first.
Until then the gateway listens only on localhost, with no tunnel.

---

## 7. QA plan

**Unit (node:test, plain Node, fast)**
- **Parameter schemas:** valid and invalid parameters for every tool; normalisation, so
  the same request always gets the same cache key.
- **Tile specs:** lists, ranges, bounding boxes, `"all"`, ocean (flag 2) tiles, outside
  the 64×64 grid, malformed names.
- **Path safety:** `..`, `%2e%2e`, absolute paths, UNC paths, drive letters,
  NUL bytes, symlinks and junctions out of `results/`, very long paths.
- **Manifest building:** sha256, sizes, empty folders, odd characters in file
  names.
- **Retention:** expiry by age and eviction to stay under the disk budget, never
  evicting a result that is being downloaded.
- **Token handling:** hashing, constant-time compare, missing, wrong and revoked tokens.

**Gateway against a fake engine (node:test)** — the fake engine can be told to succeed,
fail, hang, crash, run slowly or produce N files.
- The queue keeps its order and priority, and enforces the limits per token.
- Single-flight: 10 identical concurrent requests produce 1 export, and all 10 get the
  result.
- Cache: a repeated request returns quickly (target under 50 ms) with no engine call;
  a changed game build means a miss.
- `wait_for_job` long-polling: no request outlives its time limit, progress values
  only go up.
- Cancelling a queued job, cancelling a running one, and cancelling one that other
  agents have joined.
- Engine crash mid-job: the job is marked `ENGINE_UNAVAILABLE` with
  `retryable=true`, the engine restarts, and the next job runs. A hung engine is
  detected by the missed heartbeats.
- Gateway restart: the persisted queue resumes, half-written staging folders are
  cleaned up, and results that were already finished stay valid.
- Downloads: every file is byte-identical to its manifest hash, the zip streams and
  opens, ranged requests work, and many downloads at once don't cause problems.
- Disk full or low disk: a clean `QUOTA_EXCEEDED` error, and no partial result is ever
  treated as finished.
- Prod untouched: snapshot the modification times and hashes of
  `C:\Users\colin\wow.export` config, cache and exports before and after the whole suite.

**MCP protocol tests (real MCP SDK client)**
- Initialising, listing tools and tool schemas, calling every tool, and checking the
  error shape on bad input.
- Several MCP sessions at once, sessions that reconnect, and an expired session.

**Integration against the real game install (the engine)** — validators extended from
`tests/export-scale/run.js`:
- **OBJ:** the vertex and face counts make sense, the MTL file and textures it
  references exist, and PNG files have valid signatures.
- **glTF/GLB:** the JSON parses, the buffers are the declared length, and
  accessor bounds hold.
- **PNG and WEBP:** the image decodes at the expected size.
- **CSV:** the column count matches the table definition and the row count matches the
  table.
- **SQL:** the file parses.
- **Raw, audio, font and text:** the bytes match `casc.getFile`.
- **A golden set:**
  - 3 tiles in each map format
  - 10 models of each format, including WMOs with doodads and animated M2s
  - 50 textures
  - 20 DB2 tables
  - 5 creatures, items and decor objects each

  Each is checked against a recorded manifest, so changes in output show up.
- **Error paths:** an unknown fileDataID, a file that exists in the listfile but not in
  this build, a tile on an ocean-only map, a texture asked for as a model, and an empty
  selection.

**Load and soak**
- **Burst:** 5 simulated agents send 200 mixed requests (60% repeats, 40% new). No
  errors; p50 and p95 latency recorded for cache hits, small exports and tile jobs.
- **Overnight soak:** a loop of mixed jobs for at least 4 h. Memory and handle counts
  are sampled to check they flatten out rather than climb. The engine restarts on
  schedule and no job is lost.
- **Scale:** the existing 336-tile raw job and 100-tile baked job, run through the MCP
  path, at about the same wall time as the export-test runner (within 10%).

**Remote**
- Tailscale Funnel from outside: the health check, then an MCP call with no token
  (401), a wrong token (401) and a correct token.
- A real Claude Code cloud session connects with `.mcp.json`, exports a model and a
  tile, downloads both with `get_download_script`, and the sha256 values match.

Results go into `docs/export-service-report.md`: what passed, the timings, issues found
and fixed, and anything left open.

---

## 8. Overnight operating rules (what I will and won't do unattended)

- **Will:**
  - Work only on branch `export-service` and commit after each phase.
  - Write test exports only under `C:\Users\colin\wow.export-service\` and
    `~/wow.export-tests`.
  - Run long exports in the background.
  - Fix any bugs that turn up in the existing export code. Each fix comes with a test
    and is listed in the report.
- **Won't:**
  - Push to `main`, merge or open a PR.
  - Touch the prod folder, config or cache.
  - Change Windows system or power settings, install anything not approved below, or
    create public accounts.
  - Refactor tab code beyond exporting functions that already exist. The UI can't be
    tested unattended, so any tab change has to be followed by re-running the smoke and
    standard export suites.
- **Stop and leave notes if:**
  - free disk goes under 50 GB
  - the same failure happens 3 times with no progress
  - an approval I don't have is needed

  In those cases I carry on with any phase that isn't blocked.

## 9. Needed from you before bed

1. **Approvals:**
   - Install `@modelcontextprotocol/sdk`, `zod` and `archiver` in `service/`.
   - Register a per-user scheduled task.
   - Push the `export-service` branch to GitHub (needed for the cloud-session test).
   - Start one Claude Code cloud session to run the remote test.
2. **Tailscale:** install it, sign in, and allow Funnel. This takes a UAC prompt and a
   browser sign-in, so only you can do it; it's about 3 minutes. If it's skipped,
   phases 6 and 8 are deferred and everything else still runs.
3. **Cloud environment:** this can wait until the morning, after the security tests
   pass. Set Network access to Limited and add the exact Funnel host. Also set
   `WOW_EXPORT_TOKEN`; I'll generate the token and put it in a local file for you.
4. **Keep the laptop plugged in with the lid open,** or set closing the lid to "do
   nothing". Sleep is already off. Set this session's permission mode to one that
   won't stop for prompts overnight.
