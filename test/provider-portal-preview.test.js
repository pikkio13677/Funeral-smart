'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'provider-portal-preview.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

test('provider portal preview has one syntactically valid demo script', () => {
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'provider-portal-preview.html:inline-script' }));
});

test('provider portal preview is explicitly demo-only and never calls the live API', () => {
  assert.match(html, /Modalità anteprima/);
  assert.match(html, /dati dimostrativi/);
  assert.match(html, /Nessun dato è stato inviato al server/);
  assert.doesNotMatch(scripts[0], /fetch\s*\(|XMLHttpRequest|WebSocket/);
});

test('provider portal preview exposes only assigned-request demo fields and protects contact details', () => {
  assert.match(scripts[0], /demoRequests/);
  assert.match(scripts[0], /city/);
  assert.match(scripts[0], /service/);
  assert.match(scripts[0], /destination/);
  assert.doesNotMatch(scripts[0], /contactEmail|contactPhone|contact_email|contact_phone/);
  assert.match(html, /Contatti protetti/);
});

test('provider portal preview supports search, status filters, reason validation and local-only responses', () => {
  for (const fragment of ['data-filter="new"', 'data-filter="accepted"', 'data-filter="rejected"', 'minlength="10"', 'maxlength="500"', 'openResponse', 'item.status=pending.status']) {
    assert.ok(html.includes(fragment), 'missing preview feature: ' + fragment);
  }
});
