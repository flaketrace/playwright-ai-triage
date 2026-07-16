---
'playwright-ai-triage': minor
---

New opt-in HTTP sink: set the `sinkUrl` option (or `AI_TRIAGE_SINK_URL`) to POST each run's
triage results — payloads, classifications, fingerprints, per-class summary, and run
metadata — as a versioned JSON document (`ai-triage-sink/v1`) to your own endpoint.
`AI_TRIAGE_SINK_TOKEN` adds a bearer token. Off by default, skipped in `dryRun`, 10s timeout,
and a sink failure warns without ever affecting the build.
