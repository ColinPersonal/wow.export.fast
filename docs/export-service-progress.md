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
| 0 Branch, skeleton, plan | in progress | branch created, plan written |
| 1 Engine host mode | pending | |
| 2 Gateway core | pending | |
| 3 MCP layer | pending | |
| 4 Phase-1 exports | pending | |
| 5 Supervision | pending | |
| 6 Startup + tunnel | pending | |
| 7 Phase-2 exports | pending | |
| 8 Remote QA | pending | |
| 9 Soak + report | pending | |

## Open issues
- none yet
