'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createStagingSubmissionGuard = require('../staging-submission-guard');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('staging blocks public submissions before database handlers run', () => {
  const guard = createStagingSubmissionGuard({ env: { STAGING_MODE: 'true' } });
  const res = response();
  let continued = false;
  guard({}, res, () => { continued = true; });
  assert.equal(res.statusCode, 503);
  assert.equal(continued, false);
  assert.match(res.body.error, /Nessun dato è stato registrato/);
});

test('production mode allows public submissions through the guard', () => {
  const guard = createStagingSubmissionGuard({ env: { STAGING_MODE: 'false' } });
  const res = response();
  let continued = false;
  guard({}, res, () => { continued = true; });
  assert.equal(res.statusCode, 200);
  assert.equal(continued, true);
});
