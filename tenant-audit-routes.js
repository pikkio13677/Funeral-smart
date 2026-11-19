'use strict';

const express = require('express');
const { z } = require('zod');
const { authorizeTenant } = require('./tenant-permissions');

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(300).optional()
}).strict();

function decodeCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const parsed = z.object({
      createdAt: z.string().datetime({ offset: true }),
      id: z.string().regex(/^[1-9][0-9]*$/)
    }).strict().safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch (_) {
    return null;
  }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    createdAt: new Date(row.createdAt).toISOString(),
    id: String(row.id)
  })).toString('base64url');
}

function createTenantAuditRouter(pool) {
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

  router.get('/company/activity', authorizeTenant('audit', 'read'), async (req, res, next) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Filtri registro attività non validi.' });

    const cursor = decodeCursor(parsed.data.cursor);
    if (parsed.data.cursor && !cursor) {
      return res.status(400).json({ error: 'Cursore di paginazione non valido.' });
    }

    const values = [req.tenant.companyId];
    let cursorClause = '';
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      cursorClause = ' AND (a.created_at, a.id) < ($2::timestamptz, $3::bigint)';
    }
    values.push(parsed.data.limit + 1);

    try {
      const result = await pool.query(
        `SELECT a.id, a.username, a.action, a.resource,
                a.resource_id AS "resourceId", a.created_at AS "createdAt"
         FROM audit_log a
         WHERE a.company_id = $1${cursorClause}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $${values.length}`,
        values
      );
      const hasMore = result.rows.length > parsed.data.limit;
      const rows = hasMore ? result.rows.slice(0, parsed.data.limit) : result.rows;
      const nextCursor = hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : null;
      return res.json({ data: rows, pagination: { limit: parsed.data.limit, nextCursor } });
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = createTenantAuditRouter;
