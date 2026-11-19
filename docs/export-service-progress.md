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
| 1 Engine host mode | in progress | Bun engine + service.js ops being built by a fork on branch export-service-engine; openLocal (wowf local + CDN fallback) committed and spiked OK (open 24 s, texture/GLB/raw tile fine) |
| 2 Gateway core | done | service/src: auth, cache, jobs, engines, http; 26 tests |
| 3 MCP layer | done | service/src/tools.js, stateless Streamable HTTP; instructions for agents |
| 4 Phase-1 exports | pending | waits for the engine branch |
| 5 Supervision | done (fake engine) | crash/hang/fatal/restart/build-change/quota/eviction: 14 tests; recheck with real engines |
| 6 Startup + tunnel | started | install.ps1 / run-gateway.ps1 written, not registered yet; Tailscale signed in (colinf.tailc80785.ts.net), user enabling HTTPS + Funnel |
| 7 Phase-2 exports | pending | |
| 8 Remote QA | pending | |
| 9 Soak + report | pending | |

## Open issues
- One flaky run of "a running job interrupted by a gateway stop is rerun after restart" (failed in 251 ms once, passed in 7 later runs). Watch for it.
- archiver 8 pulls minimatch with a moderate DoS advisory (glob amplification); we never pass user input to its glob features.