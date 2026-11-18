'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Render staging blueprint uses isolated services and database', () => {
  const blueprint = fs.readFileSync(path.join(__dirname, '..', 'render-staging.yaml'), 'utf8');

  assert.match(blueprint, /name:\s*funeral-smart-api-staging/);
  assert.match(blueprint, /name:\s*funeral-smart-web-staging/);
  assert.match(blueprint, /key:\s*STAGING_MODE\s*\n\s*value:\s*"true"/);
  assert.match(blueprint, /key:\s*ENABLE_MULTI_TENANT\s*\n\s*value:\s*"false"/);
  assert.match(blueprint, /name:\s*funeral-smart-db-staging/);
  assert.match(blueprint, /databaseName:\s*funeral_smart_staging/);
  assert.match(blueprint, /fromDatabase:\s*\n\s*name:\s*funeral-smart-db-staging\s*\n\s*property:\s*connectionString/);
  assert.doesNotMatch(blueprint, /^\s*name:\s*funeral-smart-db\s*$/m);
});

test('Render staging blueprint points only to staging origins and API', () => {
  const blueprint = fs.readFileSync(path.join(__dirname, '..', 'render-staging.yaml'), 'utf8');

  assert.match(blueprint, /CORS_ORIGIN[\s\S]*?https:\/\/funeral-smart-web-staging\.onrender\.com/);
  assert.match(blueprint, /PUBLIC_APP_URL[\s\S]*?https:\/\/funeral-smart-web-staging\.onrender\.com/);
  assert.match(blueprint, /funeral-smart-api-staging\.onrender\.com/);
  assert.doesNotMatch(blueprint, /key:\s*RESEND_API_KEY/);
  assert.doesNotMatch(blueprint, /key:\s*RESEND_FROM_EMAIL/);
  assert.match(blueprint, /STAGING_MODE[\s\S]*?value:\s*\"true\"/);
  assert.match(blueprint, /DATABASE_URL[\s\S]*?name:\s*funeral-smart-db-staging/);
  assert.match(blueprint, /sed -i[\s\S]*funeral-smart-api-staging\.onrender\.com/);
  assert.doesNotMatch(blueprint, /https:\/\/funeral-smart-api\.onrender\.com/);
});

test('staging-only secrets are declared for manual configuration, never hardcoded', () => {
  const blueprint = fs.readFileSync(path.join(__dirname, '..', 'render-staging.yaml'), 'utf8');

  for (const key of ['ADMIN_API_KEY', 'BOOTSTRAP_ADMIN_TOKEN', 'TOTP_ENCRYPTION_KEY', 'EMAIL_VERIFICATION_PEPPER']) {
    const pattern = new RegExp('key:\\s*' + key + '\\s*\\n\\s*sync:\\s*false');
    assert.match(blueprint, pattern, key + ' must be supplied privately in Render');
  }
});
