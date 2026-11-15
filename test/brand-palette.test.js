'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('public and admin interfaces use the approved charcoal, gold and ivory palette', () => {
  const publicHtml = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const adminHtml = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  const icon = fs.readFileSync(require.resolve('../public/icon.svg'), 'utf8');

  assert.match(publicHtml, /--green:#191817;--green2:#302d29;--gold:#c9ad78;--bg:#f5f1e8/);
  assert.match(adminHtml, /--g:#191817;--g2:#302d29;--gold:#c9ad78;--bg:#f5f1e8/);
  assert.match(icon, /<rect[^>]+fill="#191817"/);
  assert.match(icon, /stroke="#c9ad78"/);
  assert.doesNotMatch(publicHtml, /--green:#123b32/);
  assert.doesNotMatch(adminHtml, /--g:#123b32/);
});
