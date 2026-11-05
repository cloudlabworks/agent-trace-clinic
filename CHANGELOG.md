# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-02

### Added

- Signed releases: a new `release` workflow runs on version tags. It packs the tagged source tree as `agent-trace-clinic-<version>.tar.gz` (`git archive`; the app has no build step and no runtime dependencies), records a GitHub artifact attestation (Sigstore-signed SLSA build provenance) for it, and creates a GitHub Release with the tarball and its provenance bundle `agent-trace-clinic-<version>.tar.gz.intoto.jsonl`. See "Verifying a release" in RUNNING.md.
- Property-based tests (`test/property.test.js`, fast-check 4.10.2), run by `npm test`.

### Fixed

- Inputs the property tests generated crashed the normaliser with a TypeError instead of an `Unrecognised trace format` error: an OTLP `scopeSpans` or `spans` that is not a list, a null span, an `arrayValue` or `kvlistValue` without a list, a non-string text part or refusal, a null OpenAI tool call, and object-valued token counts, start times or `error.type`. Object-valued counts and start times now read as not recorded.
- A `"__proto__"` key in tool arguments was dropped from canonical JSON, and one in OTLP attributes replaced the attribute object's prototype, so a span could gain attributes it never set.

## [0.1.0] - 2026-10-25

Public release. Unchanged scope: deterministic triage only; the model pass stays experimental.

### Added

- Published at https://github.com/cloudlabworks/agent-trace-clinic under MIT.

### Changed

- History cleaned before publication: commits re-authored to the CloudLab Works noreply identity; the MAST paper's Appendix A definitions (CC BY-NC-ND 4.0) removed from every commit; four bake-off output files that echoed that text dropped.

### Security

- Pre-publication checks: two secret scanners over full history (pattern grep and gitleaks) clean; exported HTML escapes trace content and carries a restrictive CSP; 455/455 checks and 4/4 app tests.

## Local preview - 2026-10-14

A local development release before the public repository existed; not a versioned release. It was not pushed or deployed, and stayed on a feature branch. It used no model, GPU, API credential, paid runtime or token estimate. The GitHub workflow was prepared but had not run remotely. Evidence was kept as untracked local artifacts (test, browser smoke and MCP run logs and reports); the browser smoke script is not in this repository, and `npm test` is the portable core check. See RUNNING.md for how to run it.

### Added

- Existing suite: 25 synthetic cases, 18 patient traces, 455/455 checks.
- New preview suite: 4/4 test groups.
- Chrome: four sample traces; evidence anchor navigation; HTML download; stale exports cleared; invalid input rejected; mobile-width overflow check; no page errors or external requests.
- Container build: Node 24 Alpine at pinned digest; non-root static server; healthy /healthz.
- MCP integration: actual synthetic tool-error run from sibling Failure Lab, 7 normalized steps, tool_loop + retry_storm + unhandled_tool_error.

[Unreleased]: https://github.com/cloudlabworks/agent-trace-clinic/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/cloudlabworks/agent-trace-clinic/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cloudlabworks/agent-trace-clinic/releases/tag/v0.1.0
