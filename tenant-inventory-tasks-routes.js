'use strict';

const express = require('express');
const { z } = require('zod');
const { authorizeTenant } = require('./tenant-permissions');

const itemSchema = z.object({
  sku: z.string().trim().max(60).optional().nullable(),
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(100),
  quantity: z.number().finite().min(0).optional().default(0),
  minQuantity: z.number().finite().min(0).optional().default(0),
  unit: z.string().trim().min(1).max(30).optional().default('pz'),
  unitCost: z.number().finite().min(0).optional().default(0)
}).strict();

const movementSchema = z.object({
  movementType: z.enum(['in', 'out']),
  quantity: z.number().finite().positive(),
  reason: z.string().trim().max(300).optional().nullable(),
  caseId: z.string().uuid().optional().nullable()
}).strict();

const taskSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(1500).optional().nullable(),
  dueDate: z.string().datetime().optional().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().default('normal'),
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional().default('open'),
  caseId: z.string().uuid().optional().nullable(),
  assignedTo: z.string().uuid().optional().nullable()
}).strict();

function createTenantInventoryTasksRouter(pool) {
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

  router.get('/inventory', authorizeTenant('inventory', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, sku, name, category, quantity, min_quantity AS "minQuantity", (quantity <= min_quantity) AS "lowStock",
                unit, unit_cost AS "unitCost", created_at AS "createdAt",
                updated_at AS "updatedAt"
         FROM inventory_items WHERE company_id = $1 ORDER BY name`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/inventory', authorizeTenant('inventory', 'create'), async (req, res, next) => {
    const parsed = itemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati articolo non validi.' });
    const v = parsed.data;
    try {
      const result = await pool.query(
        `INSERT INTO inventory_items
          (company_id, sku, name, category, quantity, min_quantity, unit, unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, sku, name, category, quantity,
                   min_quantity AS "minQuantity", unit, unit_cost AS "unitCost"`,
        [req.tenant.companyId, v.sku || null, v.name, v.category,
          v.quantity, v.minQuantity, v.unit, v.unitCost]
      );
      return res.status(201).json({ data: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Codice articolo già utilizzato.' });
      return next(error);
    }
  });

  router.post('/inventory/:id/movements', authorizeTenant('inventory', 'update'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = movementSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Movimento non valido.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const item = await client.query(
        'SELECT id, quantity FROM inventory_items WHERE id = $1 AND company_id = $2 FOR UPDATE',
        [id.data, req.tenant.companyId]
      );
      if (!item.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Articolo non trovato.' });
      }
      const v = parsed.data;
      if (v.caseId) {
        const caseResult = await client.query(
          'SELECT id FROM funeral_cases WHERE id = $1 AND company_id = $2',
          [v.caseId, req.tenant.companyId]
        );
        if (!caseResult.rowCount) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Pratica non appartenente all’azienda attiva.' });
        }
      }
      const current = Number(item.rows[0].quantity);
      const nextQuantity = v.movementType === 'in' ? current + v.quantity : current - v.quantity;
      if (nextQuantity < 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Giacenza insufficiente.' });
      }
      await client.query(
        'UPDATE inventory_items SET quantity = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3',
        [nextQuantity, id.data, req.tenant.companyId]
      );
      const movement = await client.query(
        `INSERT INTO stock_movements
          (company_id, item_id, movement_type, quantity, reason, case_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, item_id AS "itemId", movement_type AS "movementType",
                   quantity, reason, case_id AS "caseId", created_at AS "createdAt"`,
        [req.tenant.companyId, id.data, v.movementType, v.quantity, v.reason || null, v.caseId || null]
      );
      await client.query('COMMIT');
      return res.status(201).json({ data: movement.rows[0], quantity: nextQuantity });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally { client.release(); }
  });

  router.get('/inventory/:id/movements', authorizeTenant('inventory', 'read'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Identificativo non valido.' });
    try {
      const result = await pool.query(
        `SELECT id, movement_type AS "movementType", quantity, reason,
                case_id AS "caseId", created_at AS "createdAt"
         FROM stock_movements
         WHERE item_id = $1 AND company_id = $2 ORDER BY created_at DESC`,
        [id.data, req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.get('/tasks', authorizeTenant('tasks', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT t.id, t.title, t.description, t.due_date AS "dueDate",
                t.priority, t.status, t.case_id AS "caseId",
                t.assigned_to AS "assignedTo", t.created_at AS "createdAt",
                s.first_name AS "staffFirstName", s.last_name AS "staffLastName"
         FROM tasks t
         LEFT JOIN staff s ON s.id = t.assigned_to AND s.company_id = t.company_id
         WHERE t.company_id = $1 ORDER BY t.due_date NULLS LAST, t.created_at DESC`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/tasks', authorizeTenant('tasks', 'create'), async (req, res, next) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati attività non validi.' });
    const v = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (v.caseId) {
        const r = await client.query('SELECT id FROM funeral_cases WHERE id=$1 AND company_id=$2', [v.caseId, req.tenant.companyId]);
        if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Pratica non appartenente all’azienda attiva.' }); }
      }
      if (v.assignedTo) {
        const r = await client.query('SELECT id FROM staff WHERE id=$1 AND company_id=$2 AND active=TRUE', [v.assignedTo, req.tenant.companyId]);
        if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Operatore non appartenente all’azienda attiva o non attivo.' }); }
      }
      const result = await client.query(
        `INSERT INTO tasks
          (company_id, title, description, due_date, priority, status, case_id, assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, title, description, due_date AS "dueDate", priority,
                   status, case_id AS "caseId", assigned_to AS "assignedTo", created_at AS "createdAt"`,
        [req.tenant.companyId, v.title, v.description || null, v.dueDate || null,
          v.priority, v.status, v.caseId || null, v.assignedTo || null]
      );
      await client.query('COMMIT');
      return res.status(201).json({ data: result.rows[0] });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally { client.release(); }
  });

  router.patch('/tasks/:id', authorizeTenant('tasks', 'update'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = z.object({
      title: z.string().trim().min(1).max(180).optional(),
      description: z.string().trim().max(1500).nullable().optional(),
      dueDate: z.string().datetime().nullable().optional(),
      priority: z.enum(['low','normal','high','urgent']).optional(),
      status: z.enum(['open','in_progress','done','cancelled']).optional(),
      caseId: z.string().uuid().nullable().optional(),
      assignedTo: z.string().uuid().nullable().optional()
    }).strict().refine(v => Object.keys(v).length > 0).safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Aggiornamento non valido.' });
    const v = parsed.data, client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (v.caseId) {
        const r = await client.query('SELECT id FROM funeral_cases WHERE id=$1 AND company_id=$2', [v.caseId, req.tenant.companyId]);
        if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Pratica non appartenente all’azienda attiva.' }); }
      }
      if (v.assignedTo) {
        const r = await client.query('SELECT id FROM staff WHERE id=$1 AND company_id=$2 AND active=TRUE', [v.assignedTo, req.tenant.companyId]);
        if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Operatore non appartenente all’azienda attiva o non attivo.' }); }
      }
      const columns = { title:'title', description:'description', dueDate:'due_date', priority:'priority', status:'status', caseId:'case_id', assignedTo:'assigned_to' };
      const fields = Object.keys(v);
      const values = fields.map(k => v[k] ?? null);
      const sets = fields.map((k,i) => columns[k] + ' = $' + (i+1));
      values.push(id.data, req.tenant.companyId);
      const result = await client.query(
        `UPDATE tasks SET ${sets.join(', ')}
         WHERE id = $${values.length-1} AND company_id = $${values.length}
         RETURNING id, title, description, due_date AS "dueDate", priority, status,
                   case_id AS "caseId", assigned_to AS "assignedTo", created_at AS "createdAt"`,
        values
      );
      if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Attività non trovata.' }); }
      await client.query('COMMIT');
      return res.json({ data: result.rows[0] });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally { client.release(); }
  });

  return router;
}

module.exports = createTenantInventoryTasksRouter;
