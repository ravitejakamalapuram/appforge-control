#!/usr/bin/env node
// merge-gate.mjs — APP-234. Refuse to merge a PR whose `node-test` check run
// is not green on the PR's CURRENT head SHA.
//
// Run this immediately before `gh pr merge`. Exit 0 and silence means merge;
// any non-zero exit prints one line saying why and means do not.
//
//   node scripts/merge-gate.mjs --pr 40
//   node scripts/merge-gate.mjs --sha 1f3c9ab --check node-test
//   node scripts/merge-gate.mjs --pr 40 --json
//
// Exit codes (distinct on purpose — MISSING is not FAILED):
//   0  green      — the named check succeeded on this exact head SHA
//   1  failed     — it completed and did not succeed (incl. skipped/cancelled)
//   2  gate error — the gate could not answer: usage, token, or API failure
//   3  missing    — no such check run on this head SHA. Refuse, loudly.
//   4  pending    — queued/in_progress. Refuse rather than wait; retry later.
//
// Auth: GH_TOKEN or GITHUB_TOKEN, which agent-launch.sh already injects as the
// per-run App installation token. Both endpoints it reads are 200 under the
// App's existing grants. This script must never acquire a write scope, never
// call branch protection (plan-gated, not permission-gated), and never merge
// anything — it is a refusal, not an actuator.
import { parseArgs } from 'node:util';
import { createGithubClient, gate, DEFAULT_CHECK_NAME, DEFAULT_REPO, EXIT } from './lib/merge-gate.mjs';

function die(message) {
  process.stderr.write(`merge-gate: ${message}\n`);
  process.exit(EXIT.GATE_ERROR);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        pr: { type: 'string' },
        sha: { type: 'string' },
        repo: { type: 'string', default: DEFAULT_REPO },
        check: { type: 'string', default: DEFAULT_CHECK_NAME },
        json: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    die(err.message);
  }

  if (Boolean(values.pr) === Boolean(values.sha)) {
    die('give exactly one of --pr <number> or --sha <sha>');
  }

  let prNumber = null;
  if (values.pr) {
    prNumber = Number(values.pr);
    if (!Number.isInteger(prNumber) || prNumber <= 0) die(`--pr must be a positive integer, got: ${values.pr}`);
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  // Refusing here rather than falling through matters: an unauthenticated read
  // of a private repo 404s, which would otherwise be reported as "no check
  // run" — the gate telling the caller to investigate a check that is fine.
  if (!token) die('no GH_TOKEN/GITHUB_TOKEN in the environment; cannot read check runs');

  let result;
  try {
    result = await gate({
      github: createGithubClient({ token }),
      repo: values.repo,
      prNumber,
      sha: values.sha ?? null,
      checkName: values.check,
    });
  } catch (err) {
    die(err.message);
  }

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          exitCode: result.exitCode,
          green: result.exitCode === EXIT.GREEN,
          check: values.check,
          repo: values.repo,
          pr: prNumber,
          headSha: result.headSha,
          status: result.run?.status ?? null,
          conclusion: result.run?.conclusion ?? null,
          reason: result.reason,
        },
        null,
        2,
      )}\n`,
    );
  } else if (result.reason) {
    process.stderr.write(`merge-gate: ${result.reason}\n`);
  }

  process.exit(result.exitCode);
}

main().catch((err) => die(err.message));
