import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { buildAppJwt, installationsUrl, accessTokenUrl, pickInstallation } from '../lib/github-app.mjs';

// Fresh throwaway keypair generated at test time - never the real App key.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

test('buildAppJwt signs a JWT with the correct claims and RS256', () => {
  const nowMs = Date.parse('2026-09-28T00:00:00Z');
  const token = buildAppJwt({ appId: 5099019, privateKeyPem: privateKey, nowMs });

  const decoded = jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    clockTimestamp: Math.floor(nowMs / 1000),
  });
  assert.equal(decoded.iss, '5099019');
  assert.equal(decoded.iat, Math.floor(nowMs / 1000) - 60);
  assert.equal(decoded.exp, decoded.iat + 600);
});

test('buildAppJwt throws without appId', () => {
  assert.throws(() => buildAppJwt({ privateKeyPem: privateKey }), /appId is required/);
});

test('buildAppJwt throws without a private key', () => {
  assert.throws(() => buildAppJwt({ appId: 1 }), /privateKeyPem is required/);
});

test('installationsUrl points at the App installations endpoint', () => {
  assert.equal(installationsUrl(), 'https://api.github.com/app/installations');
});

test('accessTokenUrl builds the per-installation token endpoint', () => {
  assert.equal(
    accessTokenUrl(12345),
    'https://api.github.com/app/installations/12345/access_tokens'
  );
});

test('pickInstallation returns the single matching installation', () => {
  const installations = [
    { id: 1, account: { login: 'someoneelse' } },
    { id: 2, account: { login: 'ravitejakamalapuram' } },
  ];
  const result = pickInstallation(installations, 'ravitejakamalapuram');
  assert.equal(result.id, 2);
});

test('pickInstallation is case-insensitive on login', () => {
  const installations = [{ id: 9, account: { login: 'RavitejaKamalapuram' } }];
  const result = pickInstallation(installations, 'ravitejakamalapuram');
  assert.equal(result.id, 9);
});

test('pickInstallation throws when no installation matches', () => {
  const installations = [{ id: 1, account: { login: 'someoneelse' } }];
  assert.throws(
    () => pickInstallation(installations, 'ravitejakamalapuram'),
    /No installation found/
  );
});

test('pickInstallation throws when more than one installation matches', () => {
  const installations = [
    { id: 1, account: { login: 'ravitejakamalapuram' } },
    { id: 2, account: { login: 'ravitejakamalapuram' } },
  ];
  assert.throws(
    () => pickInstallation(installations, 'ravitejakamalapuram'),
    /Refusing to guess/
  );
});
