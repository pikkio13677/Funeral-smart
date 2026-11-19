'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const document = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PRIVACY-GDPR-READINESS.md'), 'utf8');

test('privacy readiness review is clearly internal and does not claim legal compliance', () => {
  assert.match(document, /analisi interna, non informativa legale pubblicabile/i);
  assert.match(document, /Non costituisce parere legale né attesta la conformità al GDPR/i);
});

test('privacy review covers platform-owner access, deleted inquiry retention and audit limitations', () => {
  assert.match(document, /ruolo centrale.*owner/);
  assert.match(document, /stato non equivale a cancellazione/);
  assert.match(document, /audit completo delle semplici consultazioni/);
});

test('privacy review records staging isolation without claiming a Render deployment', () => {
  assert.match(document, /STAGING_MODE=true/);
  assert.match(document, /ENABLE_MULTI_TENANT=false/);
  assert.match(document, /non è stato creato o modificato alcun servizio Render/);
});
