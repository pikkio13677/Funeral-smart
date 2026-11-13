'use strict';

const express = require('express');
const { z } = require('zod');
const { authorizeTenant } = require('./tenant-permissions');

const staffSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email().max(254).optional().nullable().or(z.literal('')),
  active: z.boolean().optional().default(true)
}).strict();

const vehicleSchema = z.object({
  plate: z.string().trim().min(1).max(20),
  makeModel: z.string().trim().min(1).max(120),
  vehicleType: z.string().trim().min(1).max(80).optional().default('Funebre'),
  status: z.enum(['available', 'assigned', 'maintenance', 'inactive']).optional().default('available'),
  nextMaintenance: z.string().trim().min(1).max(40).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable()
}).strict();

function createTenantStaffVehiclesRouter(pool) {
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

  router.get('/staff', authorizeTenant('staff', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, first_name AS "firstName", last_name AS "lastName",
                role, phone, email, active, created_at AS "createdAt"
         FROM staff WHERE company_id = $1
         ORDER BY last_name, first_name`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/staff', authorizeTenant('staff', 'create'), async (req, res, next) => {
    const parsed = staffSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati del personale non validi.' });
    const value = parsed.data;
    try {
      const result = await pool.query(
        `INSERT INTO staff
           (company_id, first_name, last_name, role, phone, email, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, first_name AS "firstName", last_name AS "lastName",
                   role, phone, email, active, created_at AS "createdAt"`,
        [req.tenant.companyId, value.firstName, value.lastName, value.role,
          value.phone || null, value.email || null, value.active]
      );
      return res.status(201).json({ data: result.rows[0] });
    } catch (error) { return next(error); }
  });

  router.patch('/staff/:id/active', authorizeTenant('staff', 'update'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = z.object({ active: z.boolean() }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Richiesta non valida.' });
    try {
      const result = await pool.query(
        'UPDATE staff SET active = $1 WHERE id = $2 AND company_id = $3 RETURNING id, active',
        [parsed.data.active, id.data, req.tenant.companyId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Persona non trovata.' });
      return res.json({ data: result.rows[0] });
    } catch (error) { return next(error); }
  });

  router.get('/vehicles', authorizeTenant('vehicles', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, plate, make_model AS "makeModel",
                vehicle_type AS "vehicleType", status,
                next_maintenance AS "nextMaintenance", notes,
                created_at AS "createdAt"
         FROM vehicles WHERE company_id = $1 ORDER BY plate`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/vehicles', authorizeTenant('vehicles', 'create'), async (req, res, next) => {
    const parsed = vehicleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati del veicolo non validi.' });
    const value = parsed.data;
    try {
      const result = await pool.query(
        `INSERT INTO vehicles
           (company_id, plate, make_model, vehicle_type, status, next_maintenance, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, plate, make_model AS "makeModel",
                   vehicle_type AS "vehicleType", status,
                   next_maintenance AS "nextMaintenance", notes`,
        [req.tenant.companyId, value.plate.toUpperCase(), value.makeModel,
          value.vehicleType, value.status, value.nextMaintenance || null, value.notes || null]
      );
      return res.status(201).json({ data: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Targa già registrata.' });
      return next(error);
    }
  });

  router.patch('/vehicles/:id/status', authorizeTenant('vehicles', 'update'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = z.object({
      status: z.enum(['available', 'assigned', 'maintenance', 'inactive'])
    }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Richiesta non valida.' });
    try {
      const result = await pool.query(
        'UPDATE vehicles SET status = $1 WHERE id = $2 AND company_id = $3 RETURNING id, status',
        [parsed.data.status, id.data, req.tenant.companyId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Veicolo non trovato.' });
      return res.json({ data: result.rows[0] });
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = createTenantStaffVehiclesRouter;
