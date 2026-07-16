# Roadmap

Directional, not a promise — ordered by intent, driven by real-world usage. Feedback and PRs
welcome (see [CONTRIBUTING.md](../CONTRIBUTING.md)); if something here matters to you, an issue
saying so moves it up.

## Near term

- **Repo-relative file paths in findings.** Findings currently render absolute CI-runner paths;
  repo-relative paths are shorter and clickable in the PR view.

## Mid term

- **Cross-shard merge** — one combined summary instead of a comment section per shard.
- **Anthropic `baseURL` / AWS Bedrock / Google Vertex support** for teams that reach Claude
  through a gateway or cloud provider.
- **GitLab merge-request comments** (`stdout` and `slack` already work on any CI).
- **Sturdier cost reporting** — the price table ships hardcoded and can go stale; unknown
  models currently report "cost unavailable".

## Later, if there's demand

- **Hosted add-on (Flaketrace)** — cross-run history, flakiness scores, suite trends. The
  reporter stays self-hosted and free either way; join the waitlist on the
  [landing page](https://triage-landing-seven.vercel.app) if you'd use this.
- **Test frameworks beyond Playwright.**
