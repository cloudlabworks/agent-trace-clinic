# Running Agent Trace Clinic

Releases exclude the experimental model pass. It does not need model weights or cloud credentials.

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

## Verifying a release

From v0.1.1, each GitHub Release has `agent-trace-clinic-<version>.tar.gz` and build provenance for it, signed through Sigstore by the `release` workflow. With the GitHub CLI:

```sh
gh attestation verify agent-trace-clinic-0.1.1.tar.gz --repo cloudlabworks/agent-trace-clinic
```

To verify offline, add `--bundle agent-trace-clinic-0.1.1.tar.gz.intoto.jsonl` (the provenance file attached to the same release). Unpack the tarball and run `npm start` in it; the runtime needs no `npm install`.

## Container

```sh
docker build -t agent-trace-clinic:local .
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1:8080:8080 agent-trace-clinic:local
```

Non-root Node 24, pinned base-image digest, no npm dependencies in the runtime.
The container listens on `PORT` (default 8080) and `HOST` (container default 0.0.0.0; direct Node default 127.0.0.1).
`GET /healthz` returns `ok`. No background jobs or persistent store.
It is packaged for a container platform, but no AWS or Google deployment has been performed.

## What is tested

The existing 455 detector/parser checks remain unchanged.
Four new test groups cover escaped report output, clean controls, CLI compatibility, static-serving boundaries and health.
A separate local Chrome smoke test exercises the four examples, evidence links, download, stale-state clearing, invalid input and mobile layout.
See the local release receipt for actual results; do not treat this list as evidence that a run passed.

## Maintenance and release boundary

Owner: Cloud Lab Works / Waku. One portable JS core shared by browser and CLI.
The old optional-model work remains experimental, outside this release.
Existing README limits still apply, particularly name-based completion checks and false positives on legitimate retries.

Out of scope for v0.1.x: hosted deployment, external client recovery benchmarks, cross-cloud deployment and production support claims.

MCP Failure Lab is a separate sibling project; its synthetic OpenAI-shaped traces already pass through this normaliser.
The bridge is a file, not a network service or shared credential.
