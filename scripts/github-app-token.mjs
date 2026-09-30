#!/usr/bin/env node
// Mints a short-lived (1h max, GitHub-imposed) installation access token
// scoped to specific repos, from a GitHub App registered in
// config/github-apps.yaml. This script's only job is minting - it prints
// the token as JSON on stdout; injecting it into a process's env is the
// caller's job (see agent-launch.sh).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { buildAppJwt, installationsUrl, accessTokenUrl, pickInstallation } from './lib/github-app.mjs';

const CONTROL_ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_CONFIG_PATH = `${CONTROL_ROOT}config/github-apps.yaml`;
const OWNER = 'ravitejakamalapuram';

// Two distinct failure exits, because the caller must treat them differently
// (APP-132). A misconfiguration is deterministic and needs a human/agent fix,
// so it stays fatal and loud. An unreachable api.github.com is transient and
// must NOT take the agent run down with it: agent-launch.sh degrades to the
// no-credential path on EX_TEMPFAIL and still starts the agent.
const EXIT_PERMANENT = 1;
const EXIT_TRANSIENT = 75; // sysexits.h EX_TEMPFAIL

// Bounded: ~6s of retry total. Long enough to ride out a blip, short enough
// that a real outage still surfaces quickly instead of stalling every run.
const RETRY_DELAYS_MS = [500, 1500, 4000];

function fail(message) {
  process.stderr.write(`github-app-token: ${message}\n`);
  process.exit(EXIT_PERMANENT);
}

function failTransient(message) {
  process.stderr.write(`github-app-token: ${message}\n`);
  process.exit(EXIT_TRANSIENT);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function githubFetch(url, { method = 'GET', token, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // undici throws (typically TypeError: fetch failed) for DNS, TLS and
    // connection-level errors. Always transient - nothing about the request
    // itself is wrong.
    const wrapped = new Error(err.message);
    wrapped.transient = true;
    throw wrapped;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${method} ${url} failed: ${res.status} ${res.statusText} ${text}`.trim());
    // 401/403/404 mean the App, key or installation is wrong - retrying just
    // repeats the same answer. 429 and 5xx are the server asking us to wait.
    err.transient = res.status === 429 || res.status >= 500;
    throw err;
  }
  return res.json();
}

// Retries only the transient classes above, then exits with the code that tells
// the caller which kind of failure it was.
async function githubFetchOrExit(label, url, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await githubFetch(url, options);
    } catch (err) {
      if (!err.transient) fail(`${label}: ${err.message}`);
      if (attempt >= RETRY_DELAYS_MS.length) {
        failTransient(`${label}: ${err.message} (after ${RETRY_DELAYS_MS.length} retries)`);
      }
      const delay = RETRY_DELAYS_MS[attempt];
      process.stderr.write(
        `github-app-token: ${label}: ${err.message}; retrying in ${delay}ms ` +
          `(${attempt + 1}/${RETRY_DELAYS_MS.length})\n`,
      );
      await sleep(delay);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string', default: 'appforge-agents' },
      repos: { type: 'string' }, // comma-separated
      config: { type: 'string', default: DEFAULT_CONFIG_PATH },
    },
  });

  if (!values.repos) fail('--repos <comma,separated,list> is required');
  const repoList = values.repos.split(',').map((r) => r.trim()).filter(Boolean);

  let config;
  try {
    config = parseYaml(readFileSync(values.config, 'utf8'));
  } catch (err) {
    fail(`cannot read/parse ${values.config}: ${err.message}`);
  }

  const appEntry = config.apps?.find((a) => a.name === values.app);
  if (!appEntry) fail(`no app named "${values.app}" in ${values.config}`);

  const keyPath = appEntry.private_key_path.startsWith('/')
    ? appEntry.private_key_path
    : `${CONTROL_ROOT}${appEntry.private_key_path}`;

  let privateKeyPem;
  try {
    privateKeyPem = readFileSync(keyPath, 'utf8');
  } catch (err) {
    fail(`cannot read private key at ${keyPath}: ${err.message}. Has it been moved or is this the wrong machine?`);
  }

  const unauthorized = repoList.filter((r) => !appEntry.installed_on.includes(r));
  if (unauthorized.length > 0) {
    fail(`repo(s) not in this App's installed_on list (config/github-apps.yaml): ${unauthorized.join(', ')}`);
  }

  const appJwt = buildAppJwt({ appId: appEntry.app_id, privateKeyPem });

  const installations = await githubFetchOrExit('could not list installations', installationsUrl(), {
    token: appJwt,
  });

  let installation;
  try {
    installation = pickInstallation(installations, OWNER);
  } catch (err) {
    fail(err.message);
  }

  const tokenResponse = await githubFetchOrExit(
    'could not mint installation token',
    accessTokenUrl(installation.id),
    { method: 'POST', token: appJwt, body: { repositories: repoList } },
  );

  process.stdout.write(JSON.stringify({ token: tokenResponse.token, expires_at: tokenResponse.expires_at }) + '\n');
}

main();
