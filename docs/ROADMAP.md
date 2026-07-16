# Roadmap

Directional, not a promise — ordered by intent, driven by real-world usage. Feedback and PRs
welcome (see [CONTRIBUTING.md](../CONTRIBUTING.md)); if something here matters to you, an issue
saying so moves it up.

## Near term

- **Prior-attempt evidence in classification payloads.** Today the model sees only the final
  attempt's error; earlier attempts' signal (e.g. backend 500s that preceded a bare timeout on
  the last retry) is lost. Including prior attempts' error signatures should improve every
  multi-attempt classification.
- **Public smoke-eval for the classifier prompt.** A small synthetic fixture set with
  class-only assertions, runnable in CI, so PRs touching `src/prompt.ts` can be evaluated in
  the open. (The full eval suite with real-world-derived fixtures stays private.)
- **Repo-relative file paths in findings.** Findings currently render absolute CI-runner paths;
  repo-relative paths are shorter and clickable in the PR view.

## Mid term

- **Cross-shard merge** — one combined summary instead of a comment section per shard.
- **Deeper delta history** — comparisons currently span only the immediately previous run.
- **Anthropic `baseURL` / AWS Bedrock / Google Vertex support** for teams that reach Claude
  through a gateway or cloud provider.
- **GitLab merge-request comments** (`stdout` and `slack` already work on any CI).
- **Sturdier cost reporting** — the price table ships hardcoded and can go stale; unknown
  models currently report "cost unavailable".
- **Flake watchlist** — recurring-failure tracking built on the existing failure fingerprints,
  so a repeat offender is called out as such instead of rediscovered every run.

## Later, if there's demand

- **Hosted dashboard / cross-run aggregation** — the reporter stays self-hosted either way;
  join the waitlist on the [landing page](https://triage-landing-seven.vercel.app) if you'd
  use this.
- **Test frameworks beyond Playwright.**
