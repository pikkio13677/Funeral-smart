'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('email verification has an independent opt-in flag and does not activate multi-tenant routes', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'auth.js'), 'utf8');
  assert.match(server, /ENABLE_EMAIL_VERIFICATION === 'true'/);
  assert.match(auth, /emailVerificationEnabled = process\.env\.ENABLE_EMAIL_VERIFICATION === 'true'/);
  assert.match(server, /const multiTenantEnabled = process\.env\.ENABLE_MULTI_TENANT === 'true'/);
  assert.match(server, /if \(multiTenantEnabled\)/);
});

test('email verification migration remains draft and is not wired into startup migration runner', () => {
  const migrate = fs.readFileSync(path.join(root, 'migrate.js'), 'utf8');
  assert.doesNotMatch(migrate, /008_email_verification/);
  const draftCheck = fs.readFileSync(path.join(root, 'scripts', 'check-draft-migrations.js'), 'utf8');
  assert.match(draftCheck, /008_email_verification\.draft\.sql/);
});

test('tenant invitation acceptance requires a previously verified matching address', () => {
  const routes = fs.readFileSync(path.join(root, 'tenant-invitation-routes.js'), 'utf8');
  assert.match(routes, /if \(!user\.emailVerifiedAt \|\| !user\.email\)/);
  assert.match(routes, /normalizeEmail\(user\.email\) !== invitedEmail/);
  assert.doesNotMatch(routes, /email_verified_at = COALESCE\(email_verified_at, NOW\(\)\)/);
});
