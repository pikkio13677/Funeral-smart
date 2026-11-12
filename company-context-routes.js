'use strict';

const express = require('express');
const { z } = require('zod');

// Dormant router: intentionally not mounted until migrations 005/006 are
// tested on a restored database and the application integration is reviewed.
module.exports = function createCompanyContextRouter(pool, authenticate, tokenHash) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with connect() is required.');
  }
  if (typeof authenticate !== 'function' || typeof tokenHash !== 'function') {
    throw new TypeError('Authentication and token hashing functions are required.');
  }

  const router = express.Router();
  router.use(authenticate);

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

    const token = req.cookies?.fs_session;
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
