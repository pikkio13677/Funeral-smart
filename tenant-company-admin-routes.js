'use strict';

const express = require('express');
const { z } = require('zod');
const { authorizeTenant } = require('./tenant-permissions');

const profilePatchSchema = z.object({
  legalName: z.string().trim().min(2).max(180).optional(),
  vatNumber: z.string().trim().max(20).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  province: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional()
}).strict().refine(v => Object.keys(v).length > 0);

const membershipPatchSchema = z.object({
  role: z.enum(['admin', 'manager', 'operator', 'warehouse', 'accounting']).optional(),
  status: z.enum(['active', 'invited', 'suspended', 'revoked']).optional()
}).strict().refine(v => Object.keys(v).length > 0);

function createTenantCompanyAdminRouter(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with query() and connect() is required.');
  }

  const router = express.Router();
  router.use((req, res, next) => {
    if (!req.tenant?.companyId || !req.tenant?.membershipId || !req.tenant?.role) {
      return res.status(403).json({ error: 'Contesto aziendale verificato richiesto.' });
    }
    return next();
  });

  router.get('/company/profile', authorizeTenant('company', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, legal_name AS "legalName", vat_number AS "vatNumber",
                address, city, province, email, phone, plan_code AS "planCode",
                status, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM companies WHERE id = $1`,
        [req.tenant.companyId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Azienda non trovata.' });
      return res.json({ data: result.rows[0] });
    } catch (error) { return next(error); }
  });

  router.patch('/company/profile', authorizeTenant('company', 'update'), async (req, res, next) => {
    const parsed = profilePatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati aziendali non validi.' });
    const columns = {
      legalName: 'legal_name', vatNumber: 'vat_number', address: 'address',
      city: 'city', province: 'province', email: 'email', phone: 'phone'
    };
    const fields = Object.keys(parsed.data);
    const values = fields.map(key => parsed.data[key] ?? null);
    const sets = fields.map((key, index) => columns[key] + ' = $' + (index + 1));
    values.push(req.tenant.companyId);
    try {
      const result = await pool.query(
        `UPDATE companies SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${values.length}
         RETURNING id, legal_name AS "legalName", vat_number AS "vatNumber",
                   address, city, province, email, phone, updated_at AS "updatedAt"`,
        values
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Azienda non trovata.' });
      return res.json({ data: result.rows[0] });
    } catch (error) { return next(error); }
  });

  router.get('/company/members', authorizeTenant('members', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT m.id AS "membershipId", m.user_id AS "userId",
                u.username, u.display_name AS "displayName",
                m.role, m.status, m.created_at AS "joinedAt"
         FROM company_memberships m
         JOIN app_users u ON u.id = m.user_id
         WHERE m.company_id = $1
         ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,
                  u.display_name, u.username`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.patch('/company/members/:membershipId', authorizeTenant('members', 'update'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.membershipId);
    const parsed = membershipPatchSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Aggiornamento membro non valido.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize membership administration for this company to prevent two
      // concurrent requests from removing the final active administrator.
      const company = await client.query(
        'SELECT id FROM companies WHERE id = $1 FOR UPDATE',
        [req.tenant.companyId]
      );
      if (!company.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Azienda non trovata.' });
      }
      const current = await client.query(
        `SELECT id, role, status FROM company_memberships
         WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [id.data, req.tenant.companyId]
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Membro non trovato in questa azienda.' });
      }
      const nextRole = parsed.data.role ?? current.rows[0].role;
      const nextStatus = parsed.data.status ?? current.rows[0].status;
      const removesActiveAdmin = current.rows[0].role === 'admin'
        && current.rows[0].status === 'active'
        && (nextRole !== 'admin' || nextStatus !== 'active');
      if (removesActiveAdmin) {
        const admins = await client.query(
          `SELECT id FROM company_memberships
           WHERE company_id = $1 AND role = 'admin' AND status = 'active'
           FOR UPDATE`,
          [req.tenant.companyId]
        );
        if (admins.rowCount <= 1) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'L’azienda deve mantenere almeno un amministratore attivo.' });
        }
      }
      const columns = { role: 'role', status: 'status' };
      const fields = Object.keys(parsed.data);
      const values = fields.map(key => parsed.data[key]);
      const sets = fields.map((key, index) => columns[key] + ' = $' + (index + 1));
      values.push(id.data, req.tenant.companyId);
      const result = await client.query(
        `UPDATE company_memberships SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${values.length - 1} AND company_id = $${values.length}
         RETURNING id AS "membershipId", user_id AS "userId", role, status`,
        values
      );
      await client.query('COMMIT');
      return res.json({ data: result.rows[0] });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally { client.release(); }
  });

  return router;
}

module.exports = createTenantCompanyAdminRouter;
