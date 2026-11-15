'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const blueprint = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
const documentation = fs.readFileSync(path.join(__dirname, '..', 'docs', 'resend-setup.md'), 'utf8');

function envBlock(name) {
  const lines = blueprint.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === '- key: ' + name);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*- key: /.test(lines[end]) && !/^databases:/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

test('Render Blueprint declares all server-side environment settings used by the application', () => {
  for (const name of [
    'ADMIN_API_KEY',
    'BOOTSTRAP_ADMIN_TOKEN',
    'TOTP_ENCRYPTION_KEY',
    'CORS_ORIGIN',
    'PUBLIC_APP_URL',
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'ENABLE_MULTI_TENANT'
  ]) {
    assert.ok(envBlock(name), 'Missing Render environment declaration: ' + name);
  }
});

test('secret values are supplied out of band and never committed in the Blueprint', () => {
  for (const name of ['ADMIN_API_KEY', 'BOOTSTRAP_ADMIN_TOKEN', 'TOTP_ENCRYPTION_KEY', 'RESEND_API_KEY']) {
    const block = envBlock(name);
    assert.match(block, /sync:\s*false/, name + ' must be configured outside the repository');
    assert.doesNotMatch(block, /value:/, name + ' must not contain a committed value');
  }
});

test('multi-tenant mode is explicitly disabled by the Render Blueprint', () => {
  assert.match(envBlock('ENABLE_MULTI_TENANT'), /value:\s*["']?false["']?/);
});

test('deployment documentation covers bootstrap, MFA, email and the disabled multi-tenant flag', () => {
  for (const name of [
    'BOOTSTRAP_ADMIN_TOKEN',
    'TOTP_ENCRYPTION_KEY',
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'ENABLE_MULTI_TENANT'
  ]) {
    assert.ok(documentation.includes('`' + name + '`'), 'Documentation is missing ' + name);
  }
});
