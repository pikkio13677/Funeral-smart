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
      const summary = await pool.query(
        `WITH bounds AS (
           SELECT date_trunc('month', NOW()) AS start_at,
                  date_trunc('month', NOW()) + interval '1 month' AS end_at
         )
         SELECT
           (SELECT COUNT(*)::int
              FROM inquiry_provider_assignments assignment, bounds
             WHERE assignment.provider_id = $1
               AND assignment.assigned_at >= bounds.start_at
               AND assignment.assigned_at < bounds.end_at) AS "monthRequests",
           (SELECT COUNT(*)::int
              FROM provider_inquiry_responses response, bounds
             WHERE response.provider_id = $1
               AND response.status = 'accepted'
               AND response.responded_at >= bounds.start_at
               AND response.responded_at < bounds.end_at) AS "monthAccepted",
           (SELECT COUNT(*)::int
              FROM provider_inquiry_responses response, bounds
             WHERE response.provider_id = $1
               AND response.status = 'rejected'
               AND response.responded_at >= bounds.start_at
               AND response.responded_at < bounds.end_at) AS "monthRejected",
           (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (response.responded_at - assignment.assigned_at)) / 3600)::numeric, 1)
              FROM provider_inquiry_responses response
              JOIN inquiry_provider_assignments assignment
                ON assignment.id = response.assignment_id
               AND assignment.provider_id = response.provider_id
             WHERE response.provider_id = $1
               AND response.responded_at >= (SELECT start_at FROM bounds)
               AND response.responded_at < (SELECT end_at FROM bounds)
               AND response.responded_at >= assignment.assigned_at) AS "averageResponseHours",
           (SELECT COUNT(*)::int
              FROM provider_user_access access
             WHERE access.provider_id = $1
               AND access.status = 'active') AS "activeMembers"`,
        [req.provider.providerId]
      );

      const trend = await pool.query(
        `WITH months AS (
           SELECT generate_series(
             date_trunc('month', NOW()) - interval '5 months',
             date_trunc('month', NOW()),
             interval '1 month'
           ) AS month_start
         ),
         assignments AS (
           SELECT date_trunc('month', assigned_at) AS month_start, COUNT(*)::int AS request_count
             FROM inquiry_provider_assignments
            WHERE provider_id = $1
              AND assigned_at >= date_trunc('month', NOW()) - interval '5 months'
              AND assigned_at < date_trunc('month', NOW()) + interval '1 month'
            GROUP BY 1
         ),
         responses AS (
           SELECT date_trunc('month', responded_at) AS month_start,
                  COUNT(*)::int AS response_count,
                  COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted_count,
                  COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_count
             FROM provider_inquiry_responses
            WHERE provider_id = $1
              AND responded_at >= date_trunc('month', NOW()) - interval '5 months'
              AND responded_at < date_trunc('month', NOW()) + interval '1 month'
            GROUP BY 1
         )
         SELECT to_char(months.month_start, 'YYYY-MM') AS month,
                COALESCE(assignments.request_count, 0)::int AS "requestCount",
                COALESCE(responses.response_count, 0)::int AS "responseCount",
                COALESCE(responses.accepted_count, 0)::int AS "acceptedCount",
                COALESCE(responses.rejected_count, 0)::int AS "rejectedCount"
           FROM months
           LEFT JOIN assignments USING (month_start)
           LEFT JOIN responses USING (month_start)
          ORDER BY months.month_start`,
        [req.provider.providerId]
      );

      res.set('Cache-Control', 'no-store');
      res.json({
        data: {
          summary: summary.rows[0] || {
            monthRequests: 0, monthAccepted: 0, monthRejected: 0,
            averageResponseHours: null, activeMembers: 0
          },
          trend: trend.rows
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
