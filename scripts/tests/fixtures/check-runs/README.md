# `check-runs/` — GitHub API payloads for the APP-234 merge gate

These are **shaped after GitHub's documented responses, not captured from a
live run.** They cannot be captures: the `node-test` workflow (APP-225) had not
landed on `main` when the gate was written, so no `node-test` check run existed
anywhere to record. Field names, `status`/`conclusion` vocabularies and the
`{total_count, check_runs[]}` envelope are taken from GitHub's REST reference
for `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` and
`GET /repos/{owner}/{repo}/pulls/{number}`; the values are invented.

Two deliberate trims:

- Only the fields the gate reads are kept (`id`, `name`, `status`,
  `conclusion`, `started_at`, `head_sha`, and `head.sha` on the PR). A fixture
  that carries fields nothing reads invites the next reader to believe they
  were verified.
- No `url`/`html_url` fields. The suite is hermetic and the workflow's VERIFIED
  block records that the only `github.com` strings under `tests/` are the
  URL-builder assertions in `github-app.test.mjs`. Keeping that true means a
  stray `github.com` in this tree is a signal, not noise.

When a real `node-test` run exists, replacing these with genuine captures is a
strict improvement. Until then, do not cite them as evidence of the live
payload shape.
