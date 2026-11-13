'use strict';

const express = require('express');
const { z } = require('zod');

// Dormant router: intentionally not mounted until migrations 005/006 are
// tested on a restored database and the application integration is reviewed.
module.exports = function createCompanyContextRouter(pool, authenticate, tokenHash, cookieName = 'fs_session') {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with connect() is required.');
  }
  if (typeof authenticate !== 'function' || typeof tokenHash !== 'function') {
    throw new TypeError('Authentication and token hashing functions are required.');
  }
  if (typeof cookieName !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(cookieName)) {
    throw new TypeError('A valid session cookie name is required.');
  }

  const router = express.Router();
  router.use(authenticate);

  router.post('/companies/bootstrap', async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Autenticazione richiesta.' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo l’amministratore iniziale può configurare la prima azienda.' });

    const parsed = z.object({
      legalName: z.string().trim().min(2).max(180),
      vatNumber: z.string().trim().max(20).optional().default(''),
      address: z.string().trim().max(500).optional().default(''),
      city: z.string().trim().max(100).optional().default(''),
      province: z.string().trim().max(80).optional().default(''),
      email: z.string().trim().email().max(254).optional().or(z.literal('')).default(''),
      phone: z.string().trim().max(40).optional().default(''),
      confirmLegacyDataOwnership: z.literal(true)
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati aziendali non validi. Conferma anche che i dati già presenti appartengono a questa impresa.' });

    const token = req.cookies?.[cookieName];
    if (typeof token !== 'string' || token.length < 32) {
      return res.status(401).json({ error: 'Sessione non valida.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query(
        `SELECT id FROM app_sessions
         WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()
         FOR UPDATE`,
        [tokenHash(token), req.user.id]
      );
      if (!session.rowCount) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Sessione non valida o scaduta.' });
      }

      // Block legacy writes while assigning all existing unscoped records to
      // the first company. This one-time operation is serialized in a transaction.
      await client.query(
        'LOCK TABLE companies, customers, funeral_cases, staff, vehicles, inventory_items, stock_movements, tasks, invoices, payments IN SHARE ROW EXCLUSIVE MODE'
      );
      const existingCompanies = await client.query('SELECT id FROM companies LIMIT 1');
      if (existingCompanies.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La prima azienda è già stata configurata. La creazione di altre aziende richiede il flusso di onboarding dedicato.' });
      }

      const values = parsed.data;
      const companyResult = await client.query(
        `INSERT INTO companies(legal_name, vat_number, address, city, province, email, phone)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, legal_name AS "legalName", city, province`,
        [values.legalName, values.vatNumber || null, values.address || null, values.city || null,
          values.province || null, values.email || null, values.phone || null]
      );
      const company = companyResult.rows[0];
      const membershipResult = await client.query(
        `INSERT INTO company_memberships(company_id, user_id, role, status)
         VALUES($1,$2,'admin','active') RETURNING id`,
        [company.id, req.user.id]
      );
      const membershipId = membershipResult.rows[0].id;

      const tables = ['customers', 'funeral_cases', 'staff', 'vehicles', 'inventory_items', 'stock_movements', 'tasks', 'invoices', 'payments'];
      const backfilled = {};
      for (const table of tables) {
        const result = await client.query('UPDATE ' + table + ' SET company_id = $1 WHERE company_id IS NULL', [company.id]);
        backfilled[table] = result.rowCount;
      }

      await client.query(
        'UPDATE app_sessions SET active_membership_id = $1, last_seen_at = NOW() WHERE id = $2',
        [membershipId, session.rows[0].id]
      );
      await client.query(
        `INSERT INTO audit_log(user_id, username, action, resource, resource_id, company_id, membership_id)
         VALUES($1,$2,'company.initial_bootstrap','company',$3,$4,$5)`,
        [req.user.id, req.user.username, company.id, company.id, membershipId]
      );
      await client.query('COMMIT');
      return res.status(201).json({
        data: { ...company, membershipId, role: 'admin' },
        backfilled,
        message: 'Prima azienda configurata. I dati preesistenti sono stati assegnati a questa impresa.'
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/companies', async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Autenticazione richiesta.' });
    try {
      const result = await pool.query(
        `SELECT c.id, c.legal_name AS "legalName", c.city, c.province,
                c.plan_code AS "planCode", m.id AS "membershipId", m.role
         FROM company_memberships m
         JOIN companies c ON c.id = m.company_id
         WHERE m.user_id = $1
           AND m.status = 'active'
           AND c.status = 'active'
         ORDER BY c.legal_name, c.id`,
        [req.user.id]
      );
      return res.json({ data: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/active-company', async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Autenticazione richiesta.' });

    const parsed = z.object({ companyId: z.string().uuid() }).strict().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Selezione azienda non valida.' });
    }

    const token = req.cookies?.[cookieName];
    if (typeof token !== 'string' || token.length < 32) {
      return res.status(401).json({ error: 'Sessione non valida.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const session = await client.query(
        `SELECT id
         FROM app_sessions
         WHERE token_hash = $1
           AND user_id = $2
           AND expires_at > NOW()
         FOR UPDATE`,
        [tokenHash(token), req.user.id]
      );

      if (!session.rowCount) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Sessione non valida o scaduta.' });
      }

      const membership = await client.query(
        `SELECT m.id AS "membershipId", m.company_id AS "companyId",
                m.role, c.legal_name AS "legalName"
         FROM company_memberships m
         JOIN companies c ON c.id = m.company_id
         WHERE m.user_id = $1
           AND m.company_id = $2
           AND m.status = 'active'
           AND c.status = 'active'
         FOR SHARE OF m, c`,
        [req.user.id, parsed.data.companyId]
      );

      if (!membership.rowCount) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Non hai accesso a questa azienda.' });
      }

      await client.query(
        'UPDATE app_sessions SET active_membership_id = $1, last_seen_at = NOW() WHERE id = $2',
        [membership.rows[0].membershipId, session.rows[0].id]
      );

      await client.query('COMMIT');
      return res.json({
        data: {
          companyId: membership.rows[0].companyId,
          membershipId: membership.rows[0].membershipId,
          legalName: membership.rows[0].legalName,
          role: membership.rows[0].role
        },
        message: 'Azienda attiva aggiornata per questa sessione.'
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
};
