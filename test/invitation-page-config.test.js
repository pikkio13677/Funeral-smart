'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '../public/invito/accetta/index.html'), 'utf8');
const apiConfig = fs.readFileSync(path.join(__dirname, '../public/api-config.js'), 'utf8');

test('invitation page loads the published backend API configuration before its application script', () => {
  const configTag = '<script src="/api-config.js"></script>';
  const inlineScript = "<script>\n'use strict';";
  assert.ok(page.includes(configTag), 'public API configuration script is missing');
  assert.ok(page.indexOf(configTag) < page.indexOf(inlineScript), 'API configuration must load before API_BASE is computed');
  assert.match(apiConfig, /window\.FUNERAL_SMART_API_URL\s*=\s*'https:\/\/funeral-smart-api\.onrender\.com'/);
});

test('invitation page keeps bearer token in the URL fragment and sends it in the POST body', () => {
  assert.match(page, /new URLSearchParams\(location\.hash\.slice\(1\)\)/);
  assert.match(page, /history\.replaceState\(null,'',location\.pathname\+location\.search\)/);
  assert.match(page, /JSON\.stringify\(\{token:invitationToken\}\)/);
});
