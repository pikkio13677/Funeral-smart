'use strict';

const express = require('express');
const { z } = require('zod');
const createProviderContext = require('./provider-portal-context');

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10000).default(0)
}).strict();

function createProviderPortalRouter(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }
  if (typeof options.authenticate !== 'function') {
    throw new TypeError('Authentication middleware is required.');
  }

  const router = express.Router();
  const providerContext = createProviderContext(pool);
  router.use(options.authenticate, providerContext);

  router.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      data: {
        providerId: req.provider.providerId,
        businessName: req.provider.businessName,
        role: req.provider.role,
        permissions: {
          viewInquiries: true,
          respondToInquiries: true,
          manageInvitations: req.provider.role === 'provider_admin',
          manageMembers: req.provider.role === 'provider_admin',
          manageMemberRoles: req.provider.role === 'provider_admin',
          viewActivityLog: req.provider.role === 'provider_admin',
          viewBusinessAnalytics: req.provider.role === 'provider_admin'
        },
        status: 'verified'
      }
    });
  });

  router.get('/dashboard', async (req, res, next) => {
    try {
      const summary = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE response.id IS NULL)::int AS "newCount",
           COUNT(*) FILTER (WHERE response.status = 'accepted')::int AS "acceptedCount",
           COUNT(*) FILTER (WHERE response.status = 'rejected')::int AS "rejectedCount",
           COUNT(*)::int AS "activeCount"
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = $1
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')`,
        [req.provider.providerId]
      );

      const recent = await pool.query(
        `SELECT assignment.id AS "assignmentId",
                inquiry.city,
                inquiry.service_type AS "serviceType",
                inquiry.destination_country AS "destinationCountry",
                inquiry.created_at AS "receivedAt",
                assignment.assigned_at AS "assignedAt",
                response.status AS "responseStatus"
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = $1
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         ORDER BY assignment.assigned_at DESC, assignment.id DESC
         LIMIT 5`,
        [req.provider.providerId]
      );

      res.set('Cache-Control', 'no-store');
      res.json({
        data: {
          provider: {
            businessName: req.provider.businessName,
            role: req.provider.role
          },
          counts: summary.rows[0] || {
            newCount: 0, acceptedCount: 0, rejectedCount: 0, activeCount: 0
          },
          recent: recent.rows
        }
      });
    } catch (error) { next(error); }
  });

  router.get('/inquiries', async (req, res, next) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Parametri di paginazione non validi.' });
    }

    try {
      const result = await pool.query(
        `SELECT assignment.id AS "assignmentId",
                inquiry.city,
                inquiry.service_type AS "serviceType",
                inquiry.destination_country AS "destinationCountry",
                inquiry.created_at AS "receivedAt",
                assignment.assigned_at AS "assignedAt",
                response.status AS "responseStatus"
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = $1
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         ORDER BY assignment.assigned_at DESC, assignment.id DESC
         LIMIT $2 OFFSET $3`,
        [req.provider.providerId, parsed.data.limit, parsed.data.offset]
      );
      res.set('Cache-Control', 'no-store');
      res.json({
        data: result.rows,
        pagination: {
          limit: parsed.data.limit,
          offset: parsed.data.offset,
          returned: result.rows.length
        }
      });
    } catch (error) { next(error); }
  });

  router.get('/inquiries/:assignmentId', async (req, res, next) => {
    const assignmentId = z.string().uuid().safeParse(req.params.assignmentId);
    if (!assignmentId.success) return res.status(400).json({ error: 'Identificativo incarico non valido.' });

    try {
      const result = await pool.query(
        `SELECT assignment.id AS "assignmentId",
                inquiry.city,
                inquiry.service_type AS "serviceType",
                inquiry.destination_country AS "destinationCountry",
                inquiry.created_at AS "receivedAt",
                assignment.assigned_at AS "assignedAt",
                response.status AS "responseStatus",
                CASE WHEN response.status = 'accepted' THEN inquiry.contact_email ELSE NULL END AS "contactEmail",
                CASE WHEN response.status = 'accepted' THEN inquiry.contact_phone ELSE NULL END AS "contactPhone"
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.id = $1
           AND assignment.provider_id = $2
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         LIMIT 1`,
        [assignmentId.data, req.provider.providerId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Incarico non trovato o non più disponibile.' });
      res.set('Cache-Control', 'no-store');
      res.json({ data: result.rows[0] });
    } catch (error) { next(error); }
  });

  router.post('/inquiries/:assignmentId/response', async (req, res, next) => {
    const assignmentId = z.string().uuid().safeParse(req.params.assignmentId);
    const parsed = z.object({
      status: z.enum(['accepted', 'rejected']),
      reason: z.string().trim().min(10).max(500)
    }).strict().safeParse(req.body);
    if (!assignmentId.success || !parsed.success) {
      return res.status(400).json({ error: 'Risposta o motivazione non valide.' });
    }

    let client;
    try {
      if (typeof pool.connect !== 'function') {
        throw new TypeError('A PostgreSQL pool with connect() is required for transactional responses.');
      }
      client = await pool.connect();
      await client.query('BEGIN');

      const assignment = await client.query(
        `SELECT assignment.id, assignment.provider_id AS "providerId",
                inquiry.status AS "inquiryStatus"
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         WHERE assignment.id = $1
           AND assignment.provider_id = $2
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         FOR UPDATE OF assignment, inquiry`,
        [assignmentId.data, req.provider.providerId]
      );
      if (!assignment.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Incarico non trovato o non più disponibile.' });
      }

      const existing = await client.query(
        'SELECT id, status FROM provider_inquiry_responses WHERE assignment_id = $1 FOR UPDATE',
        [assignmentId.data]
      );
      if (existing.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Hai già inviato una risposta per questo incarico.' });
      }

      const inserted = await client.query(
        `INSERT INTO provider_inquiry_responses
           (assignment_id, provider_id, status, reason, responded_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, assignment_id AS "assignmentId", status, responded_at AS "respondedAt"`,
        [assignmentId.data, req.provider.providerId, parsed.data.status, parsed.data.reason, req.user.id]
      );

      await client.query(
        `INSERT INTO provider_portal_audit_log
           (provider_id, user_id, assignment_id, action, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.provider.providerId,
          req.user.id,
          assignmentId.data,
          parsed.data.status === 'accepted' ? 'inquiry.accepted' : 'inquiry.rejected',
          parsed.data.reason
        ]
      );

      await client.query('COMMIT');
      res.status(201).set('Cache-Control', 'no-store').json({
        data: inserted.rows[0],
        message: parsed.data.status === 'accepted'
          ? 'Incarico accettato.'
          : 'Incarico rifiutato.'
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally {
      if (client) client.release();
    }
  });



  // Business analytics are restricted to provider administrators and scoped to the session provider.
  router.get('/dashboard/analytics', async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') {
      return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può consultare le statistiche aziendali.' });
    }
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      const sqlDateTime = value => value.getFullYear() + '-' +
        String(value.getMonth() + 1).padStart(2, '0') + '-' +
        String(value.getDate()).padStart(2, '0') + ' 00:00:00';
      const monthStartSql = sqlDateTime(monthStart);
      const nextMonthSql = sqlDateTime(nextMonthStart);
      const trendStartSql = sqlDateTime(trendStart);

      const summary = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM inquiry_provider_assignments
             WHERE provider_id = $1 AND assigned_at >= $2 AND assigned_at < $3) AS "monthRequests",
           (SELECT COUNT(*) FROM provider_inquiry_responses
             WHERE provider_id = $1 AND status = 'accepted'
               AND responded_at >= $2 AND responded_at < $3) AS "monthAccepted",
           (SELECT COUNT(*) FROM provider_inquiry_responses
             WHERE provider_id = $1 AND status = 'rejected'
               AND responded_at >= $2 AND responded_at < $3) AS "monthRejected",
           (SELECT ROUND(AVG(TIMESTAMPDIFF(SECOND, assignment.assigned_at, response.responded_at) / 3600), 1)
              FROM provider_inquiry_responses response
              JOIN inquiry_provider_assignments assignment
                ON assignment.id = response.assignment_id
               AND assignment.provider_id = response.provider_id
             WHERE response.provider_id = $1
               AND response.responded_at >= $2 AND response.responded_at < $3
               AND response.responded_at >= assignment.assigned_at) AS "averageResponseHours",
           (SELECT COUNT(*) FROM provider_user_access
             WHERE provider_id = $1 AND status = 'active') AS "activeMembers"`,
        [req.provider.providerId, monthStartSql, nextMonthSql]
      );

      const assignmentTrend = await pool.query(
        `SELECT DATE_FORMAT(assigned_at, '%Y-%m') AS month, COUNT(*) AS request_count
           FROM inquiry_provider_assignments
          WHERE provider_id = $1 AND assigned_at >= $2 AND assigned_at < $3
          GROUP BY DATE_FORMAT(assigned_at, '%Y-%m')`,
        [req.provider.providerId, trendStartSql, nextMonthSql]
      );
      const responseTrend = await pool.query(
        `SELECT DATE_FORMAT(responded_at, '%Y-%m') AS month,
                COUNT(*) AS response_count,
                SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
           FROM provider_inquiry_responses
          WHERE provider_id = $1 AND responded_at >= $2 AND responded_at < $3
          GROUP BY DATE_FORMAT(responded_at, '%Y-%m')`,
        [req.provider.providerId, trendStartSql, nextMonthSql]
      );
      const assignmentByMonth = new Map(assignmentTrend.rows.map(row => [row.month, Number(row.request_count || 0)]));
      const responseByMonth = new Map(responseTrend.rows.map(row => [row.month, row]));
      const trend = [];
      for (let offset = 0; offset < 6; offset += 1) {
        const date = new Date(now.getFullYear(), now.getMonth() - 5 + offset, 1);
        const month = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
        const response = responseByMonth.get(month) || {};
        trend.push({
          month,
          requestCount: assignmentByMonth.get(month) || 0,
          responseCount: Number(response.response_count || 0),
          acceptedCount: Number(response.accepted_count || 0),
          rejectedCount: Number(response.rejected_count || 0)
        });
      }

      res.set('Cache-Control', 'no-store');
      res.json({
        data: {
          summary: summary.rows[0] || {
            monthRequests: 0, monthAccepted: 0, monthRejected: 0,
            averageResponseHours: null, activeMembers: 0
          },
          trend
        }
      });
    } catch (error) { next(error); }
  });

  // Audit timeline is visible only to provider administrators and never returns free-text reasons.
  router.get('/activity', async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') {
      return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può consultare il registro attività.' });
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Parametri di paginazione non validi.' });
    }
    try {
      const result = await pool.query(
        `SELECT audit.id,
                audit.action,
                audit.created_at AS "createdAt",
                actor.display_name AS "actorDisplayName",
                actor.username AS "actorUsername",
                inquiry.city,
                inquiry.service_type AS "serviceType"
         FROM provider_portal_audit_log audit
         LEFT JOIN app_users actor ON actor.id = audit.user_id
         LEFT JOIN inquiry_provider_assignments assignment
           ON assignment.id = audit.assignment_id
          AND assignment.provider_id = audit.provider_id
         LEFT JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         WHERE audit.provider_id = $1
         ORDER BY audit.created_at DESC, audit.id DESC
         LIMIT $2 OFFSET $3`,
        [req.provider.providerId, parsed.data.limit, parsed.data.offset]
      );
      res.set('Cache-Control', 'no-store');
      res.json({
        data: result.rows,
        pagination: {
          limit: parsed.data.limit,
          offset: parsed.data.offset,
          returned: result.rows.length
        }
      });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = createProviderPortalRouter;
