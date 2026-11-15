'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const enabled = process.env.DATABASE_URL && process.env.RUN_PROVIDER_POSTGRES_TESTS === 'true';
(enabled ? test : test.skip)('provider publication requires approval, verification and a published price list', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const app = await client.query(
      `INSERT INTO provider_applications
        (business_name, vat_number, city, province, email, phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id, business_name, vat_number, city, province, email, phone`,
      ['Impresa CI Isolata', 'CI-' + Date.now(), 'Milano', 'MI', 'ci-provider@example.invalid', '020000000']
    );
    const a = app.rows[0];

    const approved = await client.query(
      `INSERT INTO providers (business_name, vat_number, city, province, email, phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id, status`,
      [a.business_name, a.vat_number, a.city, a.province, a.email, a.phone]
    );
    await client.query("UPDATE provider_applications SET status='approved' WHERE id=$1", [a.id]);
    const providerId = approved.rows[0].id;
    assert.equal(approved.rows[0].status, 'pending');

    let publicRows = await client.query("SELECT id FROM providers WHERE status='verified' AND id=$1", [providerId]);
    assert.equal(publicRows.rowCount, 0, 'approved but unverified provider must remain private');

    const service = await client.query("SELECT id FROM service_types WHERE code='burial' LIMIT 1");
    const price = await client.query(
      `INSERT INTO price_lists (provider_id, service_type_id, title, total_euro, vat_included, published)
       VALUES ($1,$2,'Listino CI',1200,true,false) RETURNING id`,
      [providerId, service.rows[0].id]
    );
    let publicPrices = await client.query(
      "SELECT pl.id FROM price_lists pl JOIN providers p ON p.id=pl.provider_id WHERE pl.id=$1 AND pl.published=true AND p.status='verified'",
      [price.rows[0].id]
    );
    assert.equal(publicPrices.rowCount, 0, 'unpublished price list must remain private');

    await client.query("UPDATE providers SET status='verified', verification_date=NOW() WHERE id=$1", [providerId]);
    publicRows = await client.query("SELECT id FROM providers WHERE status='verified' AND id=$1", [providerId]);
    assert.equal(publicRows.rowCount, 1, 'verified provider can appear in public results');

    publicPrices = await client.query(
      "SELECT pl.id FROM price_lists pl JOIN providers p ON p.id=pl.provider_id WHERE pl.id=$1 AND pl.published=true AND p.status='verified'",
      [price.rows[0].id]
    );
    assert.equal(publicPrices.rowCount, 0, 'verification alone must not publish a price list');

    await client.query('UPDATE price_lists SET published=true WHERE id=$1', [price.rows[0].id]);
    publicPrices = await client.query(
      "SELECT pl.id FROM price_lists pl JOIN providers p ON p.id=pl.provider_id WHERE pl.id=$1 AND pl.published=true AND p.status='verified'",
      [price.rows[0].id]
    );
    assert.equal(publicPrices.rowCount, 1, 'only verified providers with explicitly published price lists are public');
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
