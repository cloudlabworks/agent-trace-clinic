# Local preview receipt — 2026-10-14

Status: local development release only. No public push or cloud deployment.
Self-review: keep on feature branch; no main-branch merge in this turn.

- Existing suite: 25 synthetic cases, 18 patient traces, 455/455 checks.
- New preview suite: 4/4 test groups.
- Chrome: four sample traces; evidence anchor navigation; HTML download; stale exports cleared; invalid input rejected; mobile-width overflow check; no page errors or external requests.
- Container build: Node 24 Alpine at pinned digest; non-root static server; healthy /healthz.
- MCP integration: actual synthetic tool-error run from sibling Failure Lab, 7 normalized steps, tool_loop + retry_storm + unhandled_tool_error.
- No model, GPU, API credential, paid runtime or token estimate.

Local evidence (ignored artifacts): final-tests.log, browser-smoke.log, mcp-tool-errors.json, mcp-tool-errors-report.json, mcp-tool-errors.html.
The browser smoke script is retained in the private workspace receipt; npm test is the portable core check.
GitHub workflow is prepared but has not run remotely.
See LOCAL-PREVIEW.md for remaining publication and historical licensing work.
