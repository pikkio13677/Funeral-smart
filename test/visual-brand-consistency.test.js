'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pages = [
  'index.html',
  'public/index.html',
  'admin.html',
  'platform.html',
  'provider-portal.html',
  'provider-portal-preview.html',
  'invitation.html',
  'provider-invitation.html'
];

test('all principal Funeral Smart screens use the shared visual identity', () => {
  for (const file of pages) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, /FUNERAL SMART — charcoal, gold and ivory design system/, file);
    assert.match(html, /--brand-ink:#191817/, file);
    assert.match(html, /--brand-gold:#c9ad78/, file);
    assert.match(html, /--brand-paper:#f5f1e8/, file);
  }
});

test('both install manifests use the matching app theme', () => {
  for (const file of ['manifest.webmanifest', 'public/manifest.webmanifest']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.equal(manifest.background_color, '#f5f1e8', file);
    assert.equal(manifest.theme_color, '#191817', file);
  }
});

test('both app icons contain the shared dark and gold emblem', () => {
  for (const file of ['icon.svg', 'public/icon.svg']) {
    const svg = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(svg, /#191615|#171615/, file);
    assert.match(svg, /#c9ad78/, file);
    assert.match(svg, /corona a sette punte/, file);
  }
});
