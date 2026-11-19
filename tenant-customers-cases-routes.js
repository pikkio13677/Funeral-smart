'use strict';

const express = require('express');
const { z } = require('zod');
const { authorizeTenant } = require('./tenant-permissions');

const customerSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email().max(254).optional().nullable().or(z.literal('')),
  address: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(1500).optional().nullable()
}).strict();

const caseSchema = z.object({
  caseCode: z.string().trim().min(1).max(40),
  customerId: z.string().uuid().optional().nullable(),
  deceasedFirstName: z.string().trim().min(1).max(100),
  deceasedLastName: z.string().trim().min(1).max(100),
  dateOfDeath: z.string().trim().min(1).max(40).optional().nullable(),
  serviceType: z.string().trim().min(1).max(80),
  serviceDate: z.string().trim().min(1).max(40).optional().nullable(),
  location: z.string().trim().max(180).optional().nullable(),
  destination: z.string().trim().max(180).optional().nullable(),
  status: z.enum(['open', 'planned', 'in_progress', 'completed', 'cancelled']).optional().default('open'),
  estimatedTotal: z.number().nonnegative().max(10000000).optional().default(0),
  notes: z.string().trim().max(2000).optional().nullable()
}).strict();

const statusSchema = z.object({
  status: z.enum(['open', 'planned', 'in_progress', 'completed', 'cancelled'])
}).strict();

function createTenantCustomersCasesRouter(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }

  const router = express.Router();

  router.use((req, res, next) => {
    if (!req.tenant?.companyId || !req.tenant?.membershipId || !req.tenant?.role) {
      return res.status(403).json({ error: 'Contesto aziendale verificato richiesto.' });
    }
    return next();
  });

  router.get('/customers', authorizeTenant('customers', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, first_name AS "firstName", last_name AS "lastName",
                phone, email, address, notes, created_at AS "createdAt"
         FROM customers
         WHERE company_id = $1
         ORDER BY created_at DESC
         LIMIT 300`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/customers', authorizeTenant('customers', 'create'), async (req, res, next) => {
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati cliente non validi.' });
    const value = parsed.data;
    try {
      const result = await pool.query(
        `INSERT INTO customers
           (company_id, first_name, last_name, phone, email, address, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, first_name AS "firstName", last_name AS "lastName",
                   phone, email, address, notes, created_at AS "createdAt"`,
        [req.tenant.companyId, value.firstName, value.lastName, value.phone || null,
          value.email || null, value.address || null, value.notes || null]
      );
      return res.status(201).json({ data: result.rows[0] });
    } catch (error) { return next(error); }
  });

  router.get('/cases', authorizeTenant('cases', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT f.id, f.case_code AS "caseCode",
                f.deceased_first_name AS "deceasedFirstName",
                f.deceased_last_name AS "deceasedLastName",
                f.date_of_death AS "dateOfDeath", f.service_type AS "serviceType",
                f.service_date AS "serviceDate", f.location, f.destination,
                f.status, f.estimated_total AS "estimatedTotal", f.notes,
                c.first_name AS "customerFirstName", c.last_name AS "customerLastName"
         FROM funeral_cases f
         LEFT JOIN customers c
           ON c.id = f.customer_id AND c.company_id = f.company_id
         WHERE f.company_id = $1
         ORDER BY f.created_at DESC
         LIMIT 300`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/cases', authorizeTenant('cases', 'create'), async (req, res, next) => {
    const parsed = caseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati pratica non validi.' });
    const value = parsed.data;
    try {
      if (value.customerId) {
        const customer = await pool.query(
          'SELECT id FROM customers WHERE id = $1 AND company_id = $2',
          [value.customerId, req.tenant.companyId]
        );
        if (!customer.rowCount) {
          return res.status(400).json({ error: 'Il cliente selezionato non appartiene all’azienda attiva.' });
        }
      }
      const result = await pool.query(
        `INSERT INTO funeral_cases
           (company_id, case_code, customer_id, deceased_first_name, deceased_last_name,
            date_of_death, service_type, service_date, location, destination, status,
            estimated_total, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, case_code AS "caseCode", status`,
        [req.tenant.companyId, value.caseCode, value.customerId || null,
          value.deceasedFirstName, value.deceasedLastName, value.dateOfDeath || null,
          value.serviceType, value.serviceDate || null, value.location || null,
          value.destination || null, value.status, value.estimatedTotal, value.notes || null]
      );
      return res.status(201).json({ data: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Codice pratica già utilizzato.' });
      return next(error);
    }
  });

  router.patch('/cases/:id/status', authorizeTenant('cases', 'update'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = statusSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Richiesta non valida.' });
    try {
      const result = await pool.query(
        'UPDATE funeral_cases SET status = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING id, status',
        [parsed.data.status, id.data, req.tenant.companyId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Pratica non trovata.' });
      return res.json({ data: result.rows[0] });
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = createTenantCustomersCasesRouter;
