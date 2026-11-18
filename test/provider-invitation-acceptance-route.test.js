'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const pagePath = path.join(__dirname, '..', 'provider-invitation-acceptance.html');

test('provider invitation URL serves its dedicated page, separate from legacy invitations', () => {
  assert.match(server, /app\.get\('\/provider\/invito\/accetta'/);
  assert.match(server, /provider-invitation-acceptance\.html/);
  assert.match(server, /app\.get\('\/invito\/accetta'/);
  assert.ok(fs.existsSync(pagePath));
});

test('provider invitation page response applies private caching and browser protections', () => {
  const routeStart = server.indexOf("app.get('/provider/invito/accetta'");
  const routeEnd = server.indexOf('// Console proprietario piattaforma', routeStart);
  assert.notEqual(routeStart, -1);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /Cache-Control', 'no-store'/);
  assert.match(route, /Referrer-Policy', 'no-referrer'/);
  assert.match(route, /X-Robots-Tag', 'noindex, nofollow, noarchive'/);
  assert.match(route, /frame-ancestors 'none'/);
});
