'use strict';

const express = require('express');
const { z } = require('zod');
const { authorizeTenant } = require('./tenant-permissions');

const invoiceSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(60),
  caseId: z.string().uuid().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  issueDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).optional(),
  dueDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).optional().nullable(),
  amount: z.number().finite().nonnegative().max(99999999.99)
    .refine(v => Number.isInteger(v * 100), 'Importo massimo due decimali.'),
  notes: z.string().trim().max(1000).optional().nullable()
}).strict();

const paymentSchema = z.object({
  amount: z.number().finite().positive().max(99999999.99)
    .refine(v => Number.isInteger(v * 100), 'Importo massimo due decimali.'),
  paymentDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).optional(),
  method: z.string().trim().min(1).max(40),
  reference: z.string().trim().max(120).optional().nullable()
}).strict();

function createTenantInvoicesPaymentsRouter(pool) {
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

  router.get('/invoices', authorizeTenant('invoices', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT i.id, i.invoice_number AS "invoiceNumber", i.case_id AS "caseId",
                i.customer_id AS "customerId", i.issue_date AS "issueDate",
                i.due_date AS "dueDate", i.amount, i.status, i.notes,
                i.created_at AS "createdAt",
                c.first_name AS "customerFirstName", c.last_name AS "customerLastName",
                f.case_code AS "caseCode"
         FROM invoices i
         LEFT JOIN customers c ON c.id = i.customer_id AND c.company_id = i.company_id
         LEFT JOIN funeral_cases f ON f.id = i.case_id AND f.company_id = i.company_id
         WHERE i.company_id = $1
         ORDER BY i.issue_date DESC, i.created_at DESC LIMIT 300`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/invoices', authorizeTenant('invoices', 'create'), async (req, res, next) => {
    const parsed = invoiceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati fattura non validi.' });
    const v = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let customerId = v.customerId || null;
      if (v.caseId) {
        const caseResult = await client.query(
          'SELECT id, customer_id FROM funeral_cases WHERE id = $1 AND company_id = $2 FOR SHARE',
          [v.caseId, req.tenant.companyId]
        );
        if (!caseResult.rowCount) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Pratica non appartenente all’azienda attiva.' });
        }
        const caseCustomerId = caseResult.rows[0].customer_id || null;
        if (customerId && caseCustomerId && customerId !== caseCustomerId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Il cliente non corrisponde alla pratica selezionata.' });
        }
        if (!customerId) customerId = caseCustomerId;
      }
      if (customerId) {
        const customerResult = await client.query(
          'SELECT id FROM customers WHERE id = $1 AND company_id = $2',
          [customerId, req.tenant.companyId]
        );
        if (!customerResult.rowCount) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cliente non appartenente all’azienda attiva.' });
        }
      }
      const result = await client.query(
        `INSERT INTO invoices
          (company_id, invoice_number, case_id, customer_id, issue_date, due_date, amount, status, notes)
         VALUES ($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6,$7,'draft',$8)
         RETURNING id, invoice_number AS "invoiceNumber", case_id AS "caseId",
                   customer_id AS "customerId", issue_date AS "issueDate",
                   due_date AS "dueDate", amount, status, notes`,
        [req.tenant.companyId, v.invoiceNumber, v.caseId || null, customerId,
          v.issueDate || null, v.dueDate || null, v.amount.toFixed(2), v.notes || null]
      );
      await client.query('COMMIT');
      return res.status(201).json({ data: result.rows[0] });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') return res.status(409).json({ error: 'Numero fattura già utilizzato.' });
      return next(error);
    } finally { client.release(); }
  });

  router.post('/invoices/:id/issue', authorizeTenant('invoices', 'issue'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Identificativo fattura non valido.' });
    try {
      const result = await pool.query(
        `UPDATE invoices SET status = 'issued'
         WHERE id = $1 AND company_id = $2 AND status = 'draft'
         RETURNING id, invoice_number AS "invoiceNumber", status`,
        [id.data, req.tenant.companyId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Fattura non trovata o non in bozza.' });
      return res.json({ data: result.rows[0] });
    } catch (error) { return next(error); }
  });

  router.get('/invoices/:id/payments', authorizeTenant('invoices', 'read'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Identificativo fattura non valido.' });
    try {
      const result = await pool.query(
        `SELECT p.id, p.invoice_id AS "invoiceId", p.amount,
                p.payment_date AS "paymentDate", p.method, p.reference,
                p.created_at AS "createdAt"
         FROM payments p
         INNER JOIN invoices i ON i.id = p.invoice_id AND i.company_id = p.company_id
         WHERE p.invoice_id = $1 AND p.company_id = $2
         ORDER BY p.payment_date DESC, p.created_at DESC`,
        [id.data, req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/invoices/:id/payments', authorizeTenant('invoices', 'pay'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = paymentSchema.safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Dati pagamento non validi.' });
    const v = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invoice = await client.query(
        `SELECT id, amount, status FROM invoices
         WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [id.data, req.tenant.companyId]
      );
      if (!invoice.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Fattura non trovata.' });
      }
      if (!['issued', 'partial', 'overdue'].includes(invoice.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La fattura non è in uno stato che consente pagamenti.' });
      }
      const balance = await client.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS paid
         FROM payments WHERE invoice_id = $1 AND company_id = $2`,
        [id.data, req.tenant.companyId]
      );
      const payment = await client.query(
        `INSERT INTO payments (company_id, invoice_id, amount, payment_date, method, reference)
         VALUES ($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5,$6)
         RETURNING id, invoice_id AS "invoiceId", amount,
                   payment_date AS "paymentDate", method, reference, created_at AS "createdAt"`,
        [req.tenant.companyId, id.data, v.amount.toFixed(2), v.paymentDate || null, v.method, v.reference || null]
      );
      const totals = await client.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS paid
         FROM payments WHERE invoice_id = $1 AND company_id = $2`,
        [id.data, req.tenant.companyId]
      );
      const paid = Number(totals.rows[0].paid);
      const total = Number(invoice.rows[0].amount);
      if (paid > total + 0.000001) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Il pagamento supera il saldo residuo.' });
      }
      const status = paid >= total ? 'paid' : 'partial';
      await client.query(
        'UPDATE invoices SET status = $1 WHERE id = $2 AND company_id = $3',
        [status, id.data, req.tenant.companyId]
      );
      await client.query('COMMIT');
      return res.status(201).json({ data: payment.rows[0], invoiceStatus: status, paid: paid.toFixed(2), remaining: (total - paid).toFixed(2) });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally { client.release(); }
  });

  return router;
}

module.exports = createTenantInvoicesPaymentsRouter;
