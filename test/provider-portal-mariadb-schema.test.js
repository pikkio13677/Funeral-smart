'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schemaPath = path.join(__dirname, '..', 'mariadb', 'schema-provider-portal.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');

test('lo schema MariaDB contiene tutte le tabelle base e del portale', () => {
  for (const table of [
    'app_users', 'app_sessions', 'audit_log', 'providers', 'service_types', 'provider_services',
    'price_lists', 'provider_applications', 'inquiries',
    'inquiry_provider_assignments', 'provider_user_access',
    'provider_user_invitations', 'provider_inquiry_responses',
    'provider_portal_audit_log'
  ]) {
    assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS ' + table + '\\b'));
  }
});

test('il catalogo MariaDB include il servizio combinato cremazione e sepoltura', () => {
  assert.match(sql, /'cremation-burial', 'Cremazione \+ Sepoltura'/);
  assert.match(sql, /'Servizi che combinano cremazione e successiva sepoltura'/);
});

test('UUID, timestamp UTC e relazioni tenant sono definiti esplicitamente', () => {
  assert.match(sql, /CHAR\(36\) CHARACTER SET ascii COLLATE ascii_bin/);
  assert.match(sql, /DATETIME\(3\)/);
  assert.match(sql, /DEFAULT \(UTC_TIMESTAMP\(3\)\)/);
  assert.match(sql, /FOREIGN KEY \(assignment_id, provider_id\)/);
});

test('gli indici generati sostituiscono gli indici PostgreSQL parziali', () => {
  assert.match(sql, /active_inquiry_id CHAR\(36\)[^,]*NULL/);
  assert.match(sql, /UNIQUE KEY uq_assignment_one_active_per_inquiry \(active_inquiry_id\)/);
  assert.match(sql, /pending_provider_id CHAR\(36\)[^,]*NULL/);
  assert.match(sql, /pending_email VARCHAR\(254\) NULL/);
  assert.match(sql, /UNIQUE KEY uq_provider_invitation_pending_email \(pending_provider_id, pending_email\)/);
});

test('lo schema non viene collegato automaticamente all’avvio o alle migrazioni correnti', () => {
  assert.match(sql, /STAGING ONLY/);
  assert.match(sql, /NON eseguire automaticamente/);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE TABLE|DELETE FROM/i);
});

test('gli account staging supportano i ruoli amministrativi usati dal bootstrap controllato', () => {
  assert.match(sql, /ck_app_users_role CHECK \(role IN \('admin','platform_owner'/);
});
