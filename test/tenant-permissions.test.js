'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canTenant, authorizeTenant } = require('../tenant-permissions');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('admin has tenant administration but not platform administration', () => {
  assert.equal(canTenant('admin', 'members', 'invite'), true);
  assert.equal(canTenant('admin', 'company', 'update'), true);
  assert.equal(canTenant('admin', 'platform', 'manage'), false);
  assert.equal(canTenant('platform_admin', 'customers', 'read'), false);
});

test('operator cannot access accounting, membership or inventory mutations', () => {
  assert.equal(canTenant('operator', 'cases', 'create'), true);
  assert.equal(canTenant('operator', 'invoices', 'pay'), false);
  assert.equal(canTenant('operator', 'members', 'invite'), false);
  assert.equal(canTenant('operator', 'inventory', 'update'), false);
});

test('warehouse can update inventory but cannot read invoices or manage users', () => {
  assert.equal(canTenant('warehouse', 'inventory', 'update'), true);
  assert.equal(canTenant('warehouse', 'invoices', 'read'), false);
  assert.equal(canTenant('warehouse', 'members', 'read'), false);
});

test('accounting can issue and pay invoices but cannot manage operational staff', () => {
  assert.equal(canTenant('accounting', 'invoices', 'issue'), true);
  assert.equal(canTenant('accounting', 'invoices', 'pay'), true);
  assert.equal(canTenant('accounting', 'staff', 'update'), false);
  assert.equal(canTenant('accounting', 'members', 'invite'), false);
});

test('middleware denies requests without verified tenant context', () => {
  const middleware = authorizeTenant('customers', 'read');
  const res = response();
  let nextCalled = false;
  middleware({}, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('middleware denies role escalation and permits authorized tenant action', () => {
  const middleware = authorizeTenant('invoices', 'pay');
  const denied = response();
  middleware({
    tenant: { companyId: 'company-a', membershipId: 'member-a', role: 'operator' }
  }, denied, () => {});
  assert.equal(denied.statusCode, 403);

  const allowed = response();
  let nextCalled = false;
  middleware({
    tenant: { companyId: 'company-a', membershipId: 'member-a', role: 'accounting' }
  }, allowed, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('rejects incomplete policy declarations', () => {
  assert.throws(() => authorizeTenant('', 'read'), TypeError);
  assert.throws(() => authorizeTenant('customers', ''), TypeError);
});
