# Deterministic local preview — 2026-10-14

The local first release excludes the experimental model pass. It does not need model weights or cloud credentials.

## Run

```sh
npm test
npm start
```

Open http://127.0.0.1:8080. Load a synthetic example, paste a trace or open a JSON/JSONL file (maximum 2 MiB).
Reports have clickable evidence steps and downloadable HTML/JSON.
The browser performs analysis; the HTTP server serves an explicit allowlist of static assets and accepts no trace uploads.
Exported reports contain trace text: review them before sharing.

CLI export:

```sh
node cli.mjs cases/openai-tool-loop.json --html > report.html
```

## Container

```sh
docker build -t agent-trace-clinic:local .
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1:8080:8080 agent-trace-clinic:local
```

Non-root Node 24, pinned base-image digest, no npm dependencies in the runtime.
The container listens on `PORT` (default 8080) and `HOST` (container default 0.0.0.0; direct Node default 127.0.0.1).
`GET /healthz` returns `ok`. No background jobs or persistent store.
It is packaged for a container platform, but no AWS or Google deployment has been performed.
Local preview at port 8789 is a manual developer instance, not an externally available service.

## What is tested

The existing 455 detector/parser checks remain unchanged.
Four new test groups cover escaped report output, clean controls, CLI compatibility, static-serving boundaries and health.
A separate local Chrome smoke test exercises the four examples, evidence links, download, stale-state clearing, invalid input and mobile layout.
See the local release receipt for actual results; do not treat this list as evidence that a run passed.

## Maintenance and release boundary

Owner: Cloud Lab Works / Waku. One portable JS core shared by browser and CLI.
The old optional-model work remains experimental, outside this release.
Existing README limits still apply, particularly name-based completion checks and false positives on legitimate retries.

Public release is still open:
- Existing git history and old bake-off outputs need their recorded source-text/licensing cleanup.
- A fresh source/history screen and independent review precede publication.
- Cloud spending and public deployment are separate from this local preview.
- No external client recovery benchmark, cross-cloud deployment or production support claim.

MCP Failure Lab is a separate sibling project; its synthetic OpenAI-shaped traces already pass through this normaliser.
The bridge is a file, not a network service or shared credential.
