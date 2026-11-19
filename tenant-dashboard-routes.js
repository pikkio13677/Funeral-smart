'use strict';

const express = require('express');
const { authorizeTenant } = require('./tenant-permissions');

function createTenantDashboardRouter(pool) {
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

  router.get('/dashboard', authorizeTenant('dashboard', 'read'), async (req, res, next) => {
    const companyId = req.tenant.companyId;
    try {
      const [cases, customers, staff, vehicles, stock, tasks, invoices] = await Promise.all([
        pool.query(
          "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('open','planned','in_progress'))::int AS active FROM funeral_cases WHERE company_id = $1",
          [companyId]
        ),
        pool.query(
          'SELECT COUNT(*)::int AS total FROM customers WHERE company_id = $1',
          [companyId]
        ),
        pool.query(
          'SELECT COUNT(*)::int AS total FROM staff WHERE company_id = $1 AND active = TRUE',
          [companyId]
        ),
        pool.query(
          "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='available')::int AS available FROM vehicles WHERE company_id = $1",
          [companyId]
        ),
        pool.query(
          'SELECT COUNT(*) FILTER (WHERE quantity <= min_quantity)::int AS low FROM inventory_items WHERE company_id = $1',
          [companyId]
        ),
        pool.query(
          "SELECT COUNT(*)::int AS open FROM tasks WHERE company_id = $1 AND status IN ('open','in_progress')",
          [companyId]
        ),
        pool.query(
          `SELECT COALESCE(SUM(GREATEST(i.amount - COALESCE(p.paid,0),0)),0)::numeric(12,2) AS outstanding
           FROM invoices i
           LEFT JOIN (
             SELECT invoice_id, company_id, SUM(amount) AS paid
             FROM payments GROUP BY invoice_id, company_id
           ) p ON p.invoice_id = i.id AND p.company_id = i.company_id
           WHERE i.company_id = $1 AND i.status IN ('issued','partial','overdue')`,
          [companyId]
        )
      ]);

      return res.json({ data: {
        cases: cases.rows[0],
        customers: customers.rows[0],
        activeStaff: staff.rows[0].total,
        vehicles: vehicles.rows[0],
        lowStock: stock.rows[0].low,
        openTasks: tasks.rows[0].open,
        outstandingEuro: invoices.rows[0].outstanding
      }});
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createTenantDashboardRouter;
