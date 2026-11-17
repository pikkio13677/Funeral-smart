'use strict';
const express = require('express');
const { z } = require('zod');
const UUID = z.string().uuid();
const STATUS = z.enum(['active', 'suspended']);
const FILTER_STATUS = z.enum(['active', 'suspended', 'closed']);

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id }), 'utf8').toString('base64url');
}
function decodeCursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const result = z.object({ createdAt: z.string().datetime({ offset: true }), id: UUID }).safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch (_error) { return undefined; }
}


function encodeAuditCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: String(row.id) }), 'utf8').toString('base64url');
}
function decodeAuditCursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const valid = z.object({
      createdAt: z.string().datetime({ offset: true }),
      id: z.string().regex(/^[1-9][0-9]{0,18}$/)
    }).strict().safeParse(parsed);
    if (!valid.success) return undefined;
    // PostgreSQL BIGSERIAL is a signed 64-bit integer; reject out-of-range
    // cursors before they can trigger a database cast error.
    if (BigInt(valid.data.id) > 9223372036854775807n) return undefined;
    return valid.data;
  } catch (_error) { return undefined; }
}

module.exports = function createPlatformCompanyRouter(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool with query/connect is required.');
  if (typeof options.authenticate !== 'function' || typeof options.requirePlatformRole !== 'function') throw new TypeError('Authentication and platform-role middleware are required.');
  const router = express.Router();
  router.use(options.authenticate, options.requirePlatformRole('owner'));


  router.get('/audit', async (req, res, next) => {
    const parsed = z.object({
      action: z.enum(['platform.company.suspended', 'platform.company.reactivated']).optional(),
      resource: z.literal('company').optional(),
      resourceId: UUID.optional(),
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25)
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Filtri o paginazione audit non validi.' });
    const cursor = decodeAuditCursor(parsed.data.cursor);
    if (cursor === undefined) return res.status(400).json({ error: 'Cursore audit non valido.' });
    const values = [];
    const where = [];
    if (parsed.data.action) { values.push(parsed.data.action); where.push('action = $' + values.length); }
    if (parsed.data.resource) { values.push(parsed.data.resource); where.push('resource = $' + values.length); }
    if (parsed.data.resourceId) { values.push(parsed.data.resourceId); where.push('resource_id = $' + values.length); }
    if (cursor) {
      values.push(cursor.createdAt); const timestampParam = '$' + values.length;
      values.push(cursor.id); const idParam = '$' + values.length;
      where.push('(created_at < ' + timestampParam + '::timestamptz OR (created_at = ' + timestampParam + '::timestamptz AND id < ' + idParam + '::bigint))');
    }
    values.push(parsed.data.limit + 1);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    try {
      const result = await pool.query(
        'SELECT id, actor_user_id AS "actorUserId", actor_username AS "actorUsername", action, resource, resource_id AS "resourceId", reason, created_at AS "createdAt" ' +
        'FROM platform_audit_log ' + whereSql + ' ORDER BY created_at DESC,id DESC LIMIT $' + values.length,
        values
      );
      const hasMore = result.rows.length > parsed.data.limit;
      const rows = hasMore ? result.rows.slice(0, parsed.data.limit) : result.rows;
      res.json({ data: rows, page: { limit: parsed.data.limit, hasMore, nextCursor: hasMore && rows.length ? encodeAuditCursor(rows[rows.length - 1]) : null } });
    } catch (error) { next(error); }
  });

  router.get('/companies', async (req, res, next) => {
    const parsed = z.object({
      status: FILTER_STATUS.optional(), q: z.string().trim().min(1).max(100).optional(),
      cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25)
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Filtri o paginazione non validi.' });
    const cursor = decodeCursor(parsed.data.cursor);
    if (cursor === undefined) return res.status(400).json({ error: 'Cursore di paginazione non valido.' });
    try {
      const result = await pool.query(
        'SELECT c.id, c.legal_name AS "legalName", c.vat_number AS "vatNumber", c.city, c.province, c.status, c.plan_code AS "planCode", c.created_at AS "createdAt" ' +
        'FROM companies c WHERE ($1::varchar IS NULL OR c.status=$1) ' +
        'AND ($2::text IS NULL OR c.legal_name ILIKE \'%\' || $2 || \'%\' OR c.vat_number ILIKE \'%\' || $2 || \'%\') ' +
        'AND ($3::timestamptz IS NULL OR (c.created_at,c.id)<($3,$4::uuid)) ' +
        'ORDER BY c.created_at DESC,c.id DESC LIMIT $5',
        [parsed.data.status || null, parsed.data.q || null, cursor?.createdAt || null, cursor?.id || null, parsed.data.limit + 1]
      );
      const hasMore = result.rows.length > parsed.data.limit;
      const rows = hasMore ? result.rows.slice(0, parsed.data.limit) : result.rows;
      res.json({ data: rows, page: { limit: parsed.data.limit, hasMore, nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : null } });
    } catch (error) { next(error); }
  });

  router.get('/companies/:companyId', async (req, res, next) => {
    if (!UUID.safeParse(req.params.companyId).success) return res.status(400).json({ error: 'Identificativo azienda non valido.' });
    try {
      const result = await pool.query(
        'SELECT c.id,c.legal_name AS "legalName",c.vat_number AS "vatNumber",c.address,c.city,c.province,c.email,c.phone,c.status,c.plan_code AS "planCode",c.created_at AS "createdAt",c.updated_at AS "updatedAt", ' +
        '(SELECT COUNT(*)::int FROM company_memberships m WHERE m.company_id=c.id) AS "memberCount", ' +
        '(SELECT COUNT(*)::int FROM company_memberships m WHERE m.company_id=c.id AND m.status=\'active\') AS "activeMemberCount" ' +
        'FROM companies c WHERE c.id=$1', [req.params.companyId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Azienda non trovata.' });
      res.json({ data: result.rows[0] });
    } catch (error) { next(error); }
  });

  router.get('/companies/:companyId/members', async (req, res, next) => {
    if (!UUID.safeParse(req.params.companyId).success) return res.status(400).json({ error: 'Identificativo azienda non valido.' });
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Paginazione non valida.' });
    try {
      const company = await pool.query('SELECT id FROM companies WHERE id=$1', [req.params.companyId]);
      if (!company.rowCount) return res.status(404).json({ error: 'Azienda non trovata.' });
      const result = await pool.query(
        'SELECT u.id AS "userId",u.username,u.display_name AS "displayName",m.role,m.status,m.created_at AS "createdAt" ' +
        'FROM company_memberships m JOIN app_users u ON u.id=m.user_id WHERE m.company_id=$1 ' +
        'ORDER BY m.created_at DESC,m.id DESC LIMIT $2',
        [req.params.companyId, parsed.data.limit]
      );
      res.json({ data: result.rows });
    } catch (error) { next(error); }
  });

  router.patch('/companies/:companyId/status', async (req, res, next) => {
    if (!UUID.safeParse(req.params.companyId).success) return res.status(400).json({ error: 'Identificativo azienda non valido.' });
    const parsed = z.object({ status: STATUS, reason: z.string().trim().min(10).max(500) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Stato o motivazione non validi. La motivazione deve contenere almeno 10 caratteri.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query('SELECT id,status FROM companies WHERE id=$1 FOR UPDATE', [req.params.companyId]);
      if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Azienda non trovata.' }); }
      if (current.rows[0].status === 'closed') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Un’azienda chiusa non può essere riattivata da questa procedura.' }); }
      if (current.rows[0].status === parsed.data.status) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'L’azienda ha già questo stato.' }); }
      const updated = await client.query(
        'UPDATE companies SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status,updated_at AS "updatedAt"',
        [parsed.data.status, req.params.companyId]
      );
      await client.query(
        'INSERT INTO platform_audit_log (actor_user_id,actor_username,action,resource,resource_id,reason,ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [req.user.id, req.user.username || null, parsed.data.status === 'suspended' ? 'platform.company.suspended' : 'platform.company.reactivated', 'company', req.params.companyId, parsed.data.reason, req.ip || null]
      );
      await client.query('COMMIT');
      res.json({ data: updated.rows[0] });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
      next(error);
    } finally { if (client) client.release(); }
  });
  return router;
};
module.exports.encodeCursor = encodeCursor;
module.exports.decodeCursor = decodeCursor;

module.exports.encodeAuditCursor = encodeAuditCursor;
module.exports.decodeAuditCursor = decodeAuditCursor;
