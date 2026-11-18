'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const invitation = fs.readFileSync(path.join(root, 'provider-invitation.html'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'provider-portal.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('provider invitation uses existing login, MFA and authenticated acceptance', () => {
  assert.match(invitation, /\/api\/v1\/auth\/login/);
  assert.match(invitation, /\/api\/v1\/auth\/mfa\/verify-login/);
  assert.match(invitation, /\/api\/v1\/auth\/me/);
  assert.match(invitation, /\/api\/v1\/provider-portal\/invitations\/accept/);
  assert.match(invitation, /credentials:'same-origin'/);
  assert.match(invitation, /cache:'no-store'/);
  assert.match(invitation, /history\.replaceState/);
  assert.ok(invitation.includes("if(!/^[A-Za-z0-9_-]{43}$/.test(token))"));
  assert.match(invitation, /if\(accepting\)return/);
  assert.match(invitation, /button\.setAttribute\('aria-busy','true'\)/);
  assert.doesNotMatch(invitation, /invitation\/register|create account|crea account/i);
});

test('provider portal reads scoped APIs and requires a reason for every response', () => {
  assert.match(portal, /API\+'\/me'/);
  assert.match(portal, /API\+'\/dashboard'/);
  assert.match(portal, /API\+'\/inquiries\?limit=100/);
  assert.match(portal, /API\+'\/inquiries\/'\+encodeURIComponent\(id\)/);
  assert.match(portal, /API\+'\/invitations'/);
  assert.match(portal, /reason\.length<10/);
  assert.match(portal, /credentials:'same-origin'/);
  assert.match(portal, /cache:'no-store'/);
  assert.doesNotMatch(portal, /Impresa Aurora|family@example|example\.invalid|demo data/i);
  assert.doesNotMatch(portal, /localStorage|sessionStorage/);
});

test('API-provided text is inserted as text, never as HTML', () => {
  assert.match(portal, /textContent=/);
  assert.match(portal, /createTextNode/);
  assert.doesNotMatch(portal, /innerHTML\s*=/);
});

test('server serves the two portal pages with no-store and no-referrer protections', () => {
  assert.match(server, /app\.get\('\/provider\/invito\/accetta'/);
  assert.match(server, /app\.get\('\/provider\/portale'/);
  assert.match(server, /Cache-Control', 'no-store'/);
  assert.match(server, /Referrer-Policy', 'no-referrer'/);
  assert.match(server, /X-Robots-Tag', 'noindex, nofollow, noarchive'/);
  assert.match(server, /frame-ancestors 'none'/);
});
