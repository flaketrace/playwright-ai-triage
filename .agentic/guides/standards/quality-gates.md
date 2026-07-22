# Quality Gates

Gates ordered fastest → slowest. Fixing the underlying issue is the only way past a
gate — no `--no-verify`, no skipped cases, no deleted tests.

This file is scaffolded with the gates detected from the project's manifests at
install time; keep it current as the toolchain evolves. Each gate entry follows the
same shape:

```
### <Gate name>
**Run**: <exact command>
**Pass**: <what success looks like>
**Fail**: <what failure output looks like>
**Skip if**: <when the gate may be skipped, or "never">
```

## Rules

- **Blocking means blocking.** A red gate stops the pipeline; agents fix the cause,
  never the symptom (deleting the failing case, loosening the assertion, or
  allowlisting without a reason + expiry date are all symptom-fixes).
- **Every gate names its skip condition.** "Skip if: never" is a valid and common
  answer. A gate without a stated skip condition is always run.
- **Order cheap to expensive.** Lint/typecheck before unit tests before build before
  integration/E2E, so failures surface at the cheapest gate that can catch them.
- **One command per gate.** If a gate needs a multi-step incantation, wrap it in a
  script or package alias so agents and CI run the identical thing.

## Gates

<!-- Scaffolded by /agentic-init from the detected GATE_COMMANDS: one entry per
     command (or an "add a gate" note if none were detected). The Pass/Fail/Skip
     lines are conservative defaults — refine them, and add gates, as the toolchain
     grows. -->

### npm run gate
**Run**: `npm run gate`
**Pass**: exits 0
**Fail**: non-zero exit, fix the cause
**Skip if**: never
