'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const invitation = fs.readFileSync(path.join(root, 'tenant-invitation-routes.js'), 'utf8');

test('multi-tenant routes remain opt-in and are mounted only behind the explicit feature flag', () => {
  assert.match(server, /const multiTenantEnabled = process\.env\.ENABLE_MULTI_TENANT === 'true'/);
  assert.match(server, /if \(multiTenantEnabled\) \{/);
  assert.match(server, /app\.use\('\/api\/v1', auth\.authenticate, tenantContext/);
  assert.match(server, /require\('\.\/tenant-customers-cases-routes'\)/);
  assert.match(server, /require\('\.\/tenant-invoices-payments-routes'\)/);
  assert.ok(server.indexOf("app.get('/api/v1/services'") < server.indexOf('if (multiTenantEnabled) {'));
  assert.ok(server.indexOf("app.use('/api/v1/admin'") < server.indexOf('if (multiTenantEnabled) {'));
});

test('multi-tenant startup fails closed unless verification flags and database schema are ready', () => {
  assert.match(server, /ENABLE_EMAIL_VERIFICATION !== 'true'/);
  assert.match(server, /ENABLE_INVITATION_REGISTRATION !== 'true'/);
  assert.match(server, /EMAIL_VERIFICATION_PEPPER/);
  assert.match(server, /assertMultiTenantSchemaReady\(\)/);
  assert.match(server, /Migrazioni multi-azienda\/verifica email mancanti/);
  assert.match(server, /Backfill aziendale incompleto/);
  assert.match(server, /Nessuna azienda attiva con un membro attivo/);
});

test('invitation acceptance is authenticated before tenant context is applied', () => {
  const acceptance = invitation.indexOf("router.post('/company/invitations/accept'");
  const tenantMiddleware = invitation.indexOf("router.use('/company/invitations'");
  assert.ok(acceptance >= 0);
  assert.ok(tenantMiddleware > acceptance);
  assert.match(invitation, /router\\.use\\('\/company\\/invitations',/);
  assert.match(invitation, /router\.post\('\/company\/invitations\/accept', \..*authenticate/);
});

test('company context endpoints authenticate individually without intercepting unrelated public API routes', () => {
  const routes = fs.readFileSync(path.join(root, 'company-context-routes.js'), 'utf8');
  assert.match(routes, /router\.get\('\/companies', authenticate,/);
  assert.match(routes, /router\.post\('\/active-company', authenticate,/);
  assert.doesNotMatch(routes, /router\.use\(authenticate\)/);
});
