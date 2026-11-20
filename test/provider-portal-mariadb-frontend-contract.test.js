'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'provider-portal.html'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'provider-portal-mariadb', 'routes.js'), 'utf8');
const invitations = fs.readFileSync(path.join(root, 'provider-portal-mariadb', 'invitation-routes.js'), 'utf8');
const composed = fs.readFileSync(path.join(root, 'provider-portal-mariadb', 'index.js'), 'utf8');

function routeExists(source, method, route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('router\\.' + method + '\\([\\'"]' + escaped + '[\\'"]').test(source);
}

test('ogni endpoint Area Imprese chiamato dal frontend è presente nei router MariaDB', () => {
  const expected = [
    [portal, 'get', '/me'],
    [portal, 'get', '/dashboard'],
    [portal, 'get', '/inquiries'],
    [portal, 'get', '/inquiries/:assignmentId'],
    [portal, 'post', '/inquiries/:assignmentId/response'],
    [portal, 'get', '/dashboard/analytics'],
    [portal, 'get', '/activity'],
    [invitations, 'post', '/invitations'],
    [invitations, 'get', '/invitations'],
    [invitations, 'delete', '/invitations/:invitationId'],
    [invitations, 'get', '/members'],
    [invitations, 'patch', '/members/:accessId/status'],
    [invitations, 'patch', '/members/:accessId/role']
  ];
  for (const [source, method, route] of expected) {
    assert.equal(routeExists(source, method, route), true, method.toUpperCase() + ' ' + route);
  }
  assert.match(html, /API\s*\+\s*['"]\/invitations['"]/);
  assert.match(html, /API\s*\+\s*['"]\/members['"]/);
});

test('il router composto monta prima inviti e poi API protette dal contesto impresa', () => {
  const inviteMount = composed.indexOf("router.use(createMariaDbProviderInvitationRouter");
  const portalMount = composed.indexOf("router.use(createMariaDbProviderPortalRouter");
  assert.ok(inviteMount >= 0 && portalMount > inviteMount);
});

test('le risposte SQL espongono i campi letti dall’interfaccia', () => {
  for (const field of ['assignmentId', 'serviceType', 'destinationCountry', 'receivedAt', 'responseStatus', 'contactEmail', 'contactPhone']) {
    assert.ok(portal.includes('AS ' + field), 'campo dettaglio: ' + field);
  }
  for (const field of ['displayName', 'username', 'accessId', 'expiresAt']) {
    assert.ok(invitations.includes('AS ' + field), 'campo portale: ' + field);
  }
});
