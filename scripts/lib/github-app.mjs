import jwt from 'jsonwebtoken';

const MAX_JWT_LIFETIME_SEC = 600; // GitHub's documented maximum
const CLOCK_DRIFT_BUFFER_SEC = 60; // GitHub recommends backdating iat to tolerate clock drift

/**
 * Build a signed App JWT per GitHub's documented claim shape.
 * https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function buildAppJwt({ appId, privateKeyPem, nowMs = Date.now() }) {
  if (!appId) throw new Error('buildAppJwt: appId is required');
  if (!privateKeyPem) throw new Error('buildAppJwt: privateKeyPem is required');

  const nowSec = Math.floor(nowMs / 1000);
  const iat = nowSec - CLOCK_DRIFT_BUFFER_SEC;
  const exp = iat + MAX_JWT_LIFETIME_SEC;

  return jwt.sign({ iat, exp, iss: String(appId) }, privateKeyPem, { algorithm: 'RS256' });
}

export function installationsUrl() {
  return 'https://api.github.com/app/installations';
}

export function accessTokenUrl(installationId) {
  return `https://api.github.com/app/installations/${installationId}/access_tokens`;
}

/**
 * Find exactly one installation for the given account login. Throws loudly
 * on 0 or >1 matches rather than guessing which one was intended.
 */
export function pickInstallation(installations, ownerLogin) {
  const matches = installations.filter(
    (i) => i.account?.login?.toLowerCase() === ownerLogin.toLowerCase()
  );
  if (matches.length === 0) {
    throw new Error(`No installation found for account "${ownerLogin}". Has the App been installed?`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Expected exactly one installation for "${ownerLogin}", found ${matches.length}. Refusing to guess which one.`
    );
  }
  return matches[0];
}
