'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const createProviderContext = require('./provider-portal-context');

const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(['provider_admin', 'provider_operator'])
}).strict();
const acceptSchema = z.object({ token: z.string().min(32).max(200) }).strict();
const TOKEN_TTL_HOURS = 72;

function normalizeEmail(value) { return value.trim().toLowerCase(); }
function hashToken(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }

function createProviderPortalInvitationRouter({ pool, authenticate, sendInvitationEmail, publicAppUrl } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with query() and connect() is required.');
  }
  if (typeof authenticate !== 'function') throw new TypeError('Authentication middleware is required.');

  const router = express.Router();
  const providerContext = createProviderContext(pool);
  router.use(authenticate);

  async function createInvitation(providerId, req, res, next) {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Indirizzo email o ruolo non validi.' });
    if (typeof sendInvitationEmail !== 'function' || !publicAppUrl) {
      return res.status(503).json({ error: 'Inviti temporaneamente non disponibili: servizio email non configurato.' });
    }

    let baseUrl;
    try {
      baseUrl = new URL(publicAppUrl);
      if (baseUrl.protocol !== 'https:') throw new Error('HTTPS required');
    } catch (_) {
      return res.status(503).json({ error: 'Indirizzo pubblico HTTPS non configurato correttamente.' });
    }

    const email = normalizeEmail(parsed.data.email);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);
    const client = await pool.connect();
    let invitationId;
    let businessName;

    try {
      await client.query('BEGIN');
      const provider = await client.query(
        "SELECT business_name AS name FROM providers WHERE id = $1 AND status = 'verified' FOR UPDATE",
        [providerId]
      );
      if (!provider.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Impresa verificata non trovata.' });
      }
      businessName = provider.rows[0].name;

      const existingAccess = await client.query(
        'SELECT access.id FROM provider_user_access access ' +
        'JOIN app_users user_account ON user_account.id = access.user_id ' +
        "WHERE access.provider_id = $1 AND lower(user_account.email) = $2 AND access.status = 'active' LIMIT 1",
        [providerId, email]
      );
      if (existingAccess.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Questo indirizzo appartiene già a un utente attivo dell’impresa.' });
      }

      const pending = await client.query(
        "SELECT id FROM provider_user_invitations WHERE provider_id = $1 AND lower(email) = $2 " +
        "AND status = 'pending' AND expires_at > NOW() LIMIT 1",
        [providerId, email]
      );
      if (pending.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Esiste già un invito in attesa per questo indirizzo.' });
      }

      const inserted = await client.query(
        'INSERT INTO provider_user_invitations ' +
        '(provider_id, email, role, token_hash, invited_by_user_id, expires_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [providerId, email, parsed.data.role, hashToken(token), req.user.id, expiresAt]
      );
      invitationId = inserted.rows[0].id;
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') return res.status(409).json({ error: 'Esiste già un invito o un accesso per questo indirizzo.' });
      return next(error);
    } finally {
      client.release();
    }

    const url = new URL('/provider/invito/accetta', baseUrl);
    url.searchParams.set('token', token);
    try {
      await sendInvitationEmail({
        to: email,
        businessName,
        invitationUrl: url.toString(),
        expiresAt,
        role: parsed.data.role
      });
    } catch (_error) {
      try {
        await pool.query(
          "UPDATE provider_user_invitations SET status = 'revoked', revoked_at = NOW() WHERE id = $1 AND status = 'pending'",
          [invitationId]
        );
      } catch (_) {}
      return res.status(503).json({ error: 'Invito non inviato. È stato annullato: riprova più tardi.' });
    }

    return res.status(201).json({
      message: 'Invito inviato. Il collegamento è valido per 72 ore.',
      data: { invitationId, email, role: parsed.data.role, expiresAt }
    });
  }

  // First access is provisioned by a platform administrator after provider verification.
  router.post('/providers/:providerId/invitations', async (req, res, next) => {
    if (!['admin', 'platform_owner'].includes(req.user?.role)) {
      return res.status(403).json({ error: 'Solo un amministratore della piattaforma può attivare il primo accesso dell’impresa.' });
    }
    const providerId = z.string().uuid().safeParse(req.params.providerId);
    if (!providerId.success) return res.status(400).json({ error: 'Identificativo impresa non valido.' });
    return createInvitation(providerId.data, req, res, next);
  });

  // Provider administrators can invite colleagues, but cannot choose another provider.
  router.post('/invitations', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') {
      return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può invitare collaboratori.' });
    }
    return createInvitation(req.provider.providerId, req, res, next);
  });

  // Acceptance deliberately skips providerContext: the invitee has no provider access yet.
  router.post('/invitations/accept', async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Accedi con il tuo account prima di accettare l’invito.' });
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Link di invito non valido.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        'SELECT id, provider_id AS "providerId", email, role, status, ' +
        'expires_at AS "expiresAt", invited_by_user_id AS "invitedByUserId" ' +
        'FROM provider_user_invitations WHERE token_hash = $1 FOR UPDATE',
        [hashToken(parsed.data.token)]
      );
      if (!found.rowCount || found.rows[0].status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invito non valido, revocato o già utilizzato.' });
      }
      const invite = found.rows[0];
      if (new Date(invite.expiresAt).getTime() <= Date.now()) {
        await client.query(
          "UPDATE provider_user_invitations SET status = 'expired' WHERE id = $1 AND status = 'pending'",
          [invite.id]
        );
        await client.query('COMMIT');
        return res.status(410).json({ error: 'Invito scaduto. Chiedi all’impresa di inviarne uno nuovo.' });
      }

      const userResult = await client.query(
        'SELECT id, email, email_verified_at AS "emailVerifiedAt", active FROM app_users WHERE id = $1 FOR UPDATE',
        [req.user.id]
      );
      if (!userResult.rowCount || !userResult.rows[0].active) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Account non attivo.' });
      }
      const user = userResult.rows[0];
      if (!user.email || !user.emailVerifiedAt || normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Accedi con un account che abbia l’indirizzo email dell’invito verificato.' });
      }

      const provider = await client.query(
        "SELECT id FROM providers WHERE id = $1 AND status = 'verified' FOR UPDATE",
        [invite.providerId]
      );
      if (!provider.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'L’impresa non è più verificata e l’invito non può essere accettato.' });
      }

      const existing = await client.query(
        'SELECT id FROM provider_user_access WHERE provider_id = $1 AND user_id = $2 FOR UPDATE',
        [invite.providerId, req.user.id]
      );
      if (existing.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Questo account ha già un accesso registrato per l’impresa.' });
      }

      const access = await client.query(
        "INSERT INTO provider_user_access(provider_id, user_id, role, status, invited_by_user_id) " +
        "VALUES($1, $2, $3, 'active', $4) RETURNING id",
        [invite.providerId, req.user.id, invite.role, invite.invitedByUserId || null]
      );
      await client.query(
        "UPDATE provider_user_invitations SET status = 'accepted', accepted_at = NOW(), accepted_by_user_id = $2 " +
        "WHERE id = $1 AND status = 'pending'",
        [invite.id, req.user.id]
      );
      await client.query(
        "INSERT INTO provider_portal_audit_log(provider_id, user_id, action, reason) " +
        "VALUES($1, $2, 'provider.invitation.accepted', 'Accesso attivato tramite invito verificato')",
        [invite.providerId, req.user.id]
      );
      await client.query('COMMIT');
      res.status(201).set('Cache-Control', 'no-store').json({
        message: 'Invito accettato. Ora puoi accedere al portale dell’impresa.',
        data: { accessId: access.rows[0].id, providerId: invite.providerId, role: invite.role }
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') return res.status(409).json({ error: 'Questo accesso è già stato attivato.' });
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = createProviderPortalInvitationRouter;
