'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl
  ? test
  : test.skip;

integration('public inquiry rows persist and are readable on disposable PostgreSQL', async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const inserted = await client.query(
      `INSERT INTO inquiries
        (city, service_type, destination_country, budget_euro, notes,
         contact_email, contact_phone, privacy_consent, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received')
       RETURNING id, city, service_type AS "serviceType",
         destination_country AS "destinationCountry",
         budget_euro AS "budgetEuro", notes,
         contact_email AS "contactEmail", contact_phone AS "contactPhone",
         privacy_consent AS "privacyConsent", status,
         created_at AS "createdAt"`,
      ['Comune test CI', 'Cremazione', null, 2500, 'Richiesta automatizzata CI',
       'ci-test@example.invalid', null, true]
    );

    assert.equal(inserted.rowCount, 1);
    const row = inserted.rows[0];
    assert.match(row.id, /^[0-9a-f-]{36}$/i);
    assert.equal(row.city, 'Comune test CI');
    assert.equal(row.serviceType, 'Cremazione');
    assert.equal(row.budgetEuro, 2500);
    assert.equal(row.contactEmail, 'ci-test@example.invalid');
    assert.equal(row.privacyConsent, true);
    assert.equal(row.status, 'received');

    const listed = await client.query(
      `SELECT id, city, service_type AS "serviceType",
        destination_country AS "destinationCountry",
        budget_euro AS "budgetEuro", notes,
        contact_email AS "contactEmail", contact_phone AS "contactPhone",
        status, created_at AS "createdAt"
       FROM inquiries WHERE id = $1 ORDER BY created_at DESC LIMIT 200`,
      [row.id]
    );

    assert.equal(listed.rowCount, 1);
    assert.equal(listed.rows[0].id, row.id);
    assert.equal(listed.rows[0].contactEmail, 'ci-test@example.invalid');

    await assert.rejects(
      client.query(
        `INSERT INTO inquiries (city, service_type, privacy_consent)
         VALUES ($1,$2,true)`,
        ['Comune senza recapito', 'Sepoltura']
      ),
      error => error.code === '23514'
    );
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
