'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createStagingSubmissionGuard = require('../staging-submission-guard');

function invokeGuard(env) {
  let nextCalled = false;
  let statusCode;
  let body;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    }
  };
  createStagingSubmissionGuard({ env })({}, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, body };
}

test('staging blocks public submissions before they can write to the database', () => {
  const result = invokeGuard({ STAGING_MODE: 'true' });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 503);
  assert.match(result.body.error, /Invio disabilitato/);
});

test('production submissions are not blocked by the staging guard', () => {
  const result = invokeGuard({ STAGING_MODE: 'false' });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, undefined);
  assert.equal(result.body, undefined);
});
