#!/usr/bin/env node
// pr-queue.mjs — APP-323. Ranked table of every open PR in the repos listed in
// config/pr-queue.yaml: ready to merge first, then needs-rebase, red CI,
// waiting, drafts. Stacked PRs and branches other PRs are based on are flagged
// so nobody deletes a base branch (lesson 19).
//
//   node scripts/pr-queue.mjs            # markdown, the CEO daily report's "PR queue" section
//   node scripts/pr-queue.mjs --json     # the same rows as JSON
//   node scripts/pr-queue.mjs --repo appforge-control --repo InvTrack
//
// Exit codes:
//   0  every repo read
//   1  output printed, but at least one repo was UNREADABLE (listed in the output)
//   2  usage, config or token error; nothing printed on stdout
//
// Auth: GH_TOKEN or GITHUB_TOKEN, the per-run App installation token that
// agent-launch.sh injects. Read-only: this script never writes to GitHub.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { collectQueue, createGithubClient, renderTable } from './lib/pr-queue.mjs';

const CONFIG_PATH = new URL('../config/pr-queue.yaml', import.meta.url);

function die(message) {
  process.stderr.write(`pr-queue: ${message}\n`);
  process.exit(2);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        json: { type: 'boolean', default: false },
        repo: { type: 'string', multiple: true },
      },
    }));
  } catch (err) {
    die(err.message);
  }

  let config;
  try {
    config = parseYaml(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    die(`cannot read config/pr-queue.yaml: ${err.message}`);
  }
  if (!config?.owner || !Array.isArray(config.repos) || config.repos.length === 0) {
    die('config/pr-queue.yaml needs `owner` and a non-empty `repos` list');
  }
  const repos = values.repo ?? config.repos;

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  // Without a token every private repo 404s and the queue would look empty.
  if (!token) die('no GH_TOKEN/GITHUB_TOKEN in the environment; cannot read pull requests');

  const queue = await collectQueue({ github: createGithubClient({ token }), owner: config.owner, repos });
  const now = new Date();

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({ generatedAt: now.toISOString(), owner: config.owner, repos, ...queue }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(renderTable(queue, { date: now.toISOString().slice(0, 10) }));
  }
  process.exit(queue.unreadable.length ? 1 : 0);
}

main().catch((err) => die(err.message));
