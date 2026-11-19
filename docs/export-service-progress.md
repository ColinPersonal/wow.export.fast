# Export service: progress log

The plan is in [export-service-plan.md](export-service-plan.md). This log is updated
at the end of every phase.

## Approvals (given by the user on 2026-11-18, for unattended work on branch `export-service`)
- Install `@modelcontextprotocol/sdk`, `zod` and `archiver`, only inside `service/`.
- Commit after each phase and push the `export-service` branch. Never push to or merge
  into `main`.
- Register a per-user startup task, or a Startup-folder shortcut, for the service.
- Start one Claude Code cloud session for the remote test, but only after Funnel is
  live and the security tests pass.
- Disk budget: 75 GB, covering cached results and test exports. Stop at 50 GB free.
- Tailscale: the user installs it and signs in. Funnel is turned on only after the
  auth and path-safety tests are green.
- Never touch the prod folder `C:\Users\colin\wow.export`, its config or its cache.

## Decisions
- 2026-11-18: build on the existing headless MCP (src/js/headless, Bun) instead of new NW.js engines; NW.js only hosts WebGL-only kinds (baked terrain, minimaps) later. See plan Revision 2.
- 2026-11-18: game data per request; default wowf from the local install (CDN fallback), other products from the CDN.

## Status
| Phase | State | Notes |
|---|---|---|
| 0 Branch, skeleton, plan | done | plan Revision 2; service/ package |
| 1 Engine host mode | done | export-service-engine merged (4b9b86a0): Bun engine over PROTOCOL.md, service ops, heightmap/parse-table moved out of the tabs, PNG bit-depth fix; 201 repo tests, smoke + standard suites pass with the merged tree |
| 2 Gateway core | done | service/src: auth, cache, jobs, engines, http; 26 tests |
| 3 MCP layer | done | service/src/tools.js, stateless Streamable HTTP; instructions for agents |
| 4 Phase-1 exports | done | e2e with real wowf engines (service/test-e2e/run.js): 24/24 on a clean root - search, tables, textures, GLB/OBJ/WMO, CSV, raw files, map raw + OBJ tiles, download script, zip, quick lane under bulk load, 5 concurrent agents |
| 5 Supervision | done | 43 gateway tests (adds moveDir retry tests) |
| 6 Startup + tunnel | started | 2026-11-19: scheduled task `wow-export-service` registered from C:\Repos\wow.export.fast\service and running; gateway healthy on 127.0.0.1:8787 with warm wowf engines; `cloud-agents` token created (kept in ~/wow.export-service, not in the repo); publicUrl set to https://colinf.tailc80785.ts.net. Waiting on the user to enable Funnel for the tailnet before `tailscale funnel --bg 8787` |
| 7 Phase-2 exports | pending | |
| 8 Remote QA | pending | |
| 9 Soak + report | pending | |

## Open issues
- Fixed 2026-11-19: committing a result failed with EPERM when another process briefly held a file in staging (seen once on a WMO export). Results now move with retries, then copy-and-delete.
- Fixed 2026-11-19: the debug nw.exe ignores process.exit after an export-test run, so suites waited 4 h. tests/export-scale/run.js now stops the app 60 s after the report appears.
- Fixed 2026-11-19: run-gateway.ps1 logged through PowerShell 5.1's `*>>`, which wrote UTF-16 and wrapped stderr lines in error records. cmd.exe now does the redirect, to logs/gateway-stdout.log (logs/gateway.log belongs to the gateway itself).
- The start-up task runs from C:\Repos\wow.export.fast, so that checkout must stay on export-service (or a branch that has service/).
- The e2e test ran curl synchronously inside the gateway process and deadlocked; now async.
- One flaky run of "a running job interrupted by a gateway stop is rerun after restart" (failed in 251 ms once, passed in 7 later runs). Watch for it.
- archiver 8 pulls minimatch with a moderate DoS advisory (glob amplification); we never pass user input to its glob features.