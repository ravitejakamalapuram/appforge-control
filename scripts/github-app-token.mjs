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

function fail(message) {
  process.stderr.write(`github-app-token: ${message}\n`);
  process.exit(1);
}

async function githubFetch(url, { method = 'GET', token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${url} failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
  return res.json();
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

  let installations;
  try {
    installations = await githubFetch(installationsUrl(), { token: appJwt });
  } catch (err) {
    fail(`could not list installations: ${err.message}`);
  }

  let installation;
  try {
    installation = pickInstallation(installations, OWNER);
  } catch (err) {
    fail(err.message);
  }

  let tokenResponse;
  try {
    tokenResponse = await githubFetch(accessTokenUrl(installation.id), {
      method: 'POST',
      token: appJwt,
      body: { repositories: repoList },
    });
  } catch (err) {
    fail(`could not mint installation token: ${err.message}`);
  }

  process.stdout.write(JSON.stringify({ token: tokenResponse.token, expires_at: tokenResponse.expires_at }) + '\n');
}

main();
