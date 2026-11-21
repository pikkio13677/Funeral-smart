'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const blueprint = () => fs.readFileSync(path.join(__dirname, '..', 'render-staging.yaml'), 'utf8');

test('Render staging blueprint uses isolated services and external staging database', () => {
  const yaml = blueprint();

  for (const expected of [
    'name: funeral-smart-api-staging',
    'name: funeral-smart-web-staging',
    'value: "true"',
    'value: "false"',
    'key: ENABLE_MULTI_TENANT',
    'key: MULTI_TENANT_CUTOVER_APPROVED',
    'key: ENABLE_PROVIDER_PORTAL'
  ]) assert.ok(yaml.includes(expected), 'Blueprint must contain ' + expected);

  assert.ok(yaml.includes('key: DATABASE_URL\n        sync: false'));
  assert.ok(!yaml.includes('fromDatabase:'));
  assert.ok(!yaml.includes('databases:'));
  assert.ok(!yaml.includes('name: funeral-smart-db\n'));
});

test('Render staging blueprint points only to staging origins and API', () => {
  const yaml = blueprint();

  assert.ok(yaml.includes('https://funeral-smart-web-staging-cszq.onrender.com'));
  assert.ok(yaml.includes('https://funeral-smart-api-staging-cszq.onrender.com'));
  assert.ok(yaml.includes('DATABASE_URL'));
  assert.ok(!yaml.includes('key: RESEND_API_KEY'));
  assert.ok(!yaml.includes('key: RESEND_FROM_EMAIL'));
  assert.ok(yaml.includes('STAGING_MODE'));
  assert.ok(yaml.includes("sed -i 's#https://funeral-smart-api.onrender.com#https://funeral-smart-api-staging-cszq.onrender.com#g"));
});

test('staging-only secrets are declared for manual configuration, never hardcoded', () => {
  const yaml = blueprint();

  for (const key of ['ADMIN_API_KEY', 'BOOTSTRAP_ADMIN_TOKEN', 'TOTP_ENCRYPTION_KEY', 'EMAIL_VERIFICATION_PEPPER']) {
    assert.ok(yaml.includes('key: ' + key + '\n        sync: false'), key + ' must be supplied privately in Render');
  }
});
