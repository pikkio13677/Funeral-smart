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

  // Only provider administrators can inspect invitation history for their own provider.
  router.get('/invitations', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') {
      return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può gestire gli inviti.' });
    }
    try {
      const result = await pool.query(
        "SELECT id, email, role, " +
        "CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS status, " +
        "created_at AS \"createdAt\", expires_at AS \"expiresAt\", " +
        "accepted_at AS \"acceptedAt\", revoked_at AS \"revokedAt\" " +
        "FROM provider_user_invitations WHERE provider_id = $1 " +
        "ORDER BY created_at DESC, id DESC LIMIT 50",
        [req.provider.providerId]
      );
      return res.status(200).set('Cache-Control', 'no-store').json({ data: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  // Revocation is provider-scoped, serialized with acceptance, and audited atomically.
  router.delete('/invitations/:invitationId', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') {
      return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può revocare gli inviti.' });
    }
    const invitationId = z.string().uuid().safeParse(req.params.invitationId);
    if (!invitationId.success) return res.status(400).json({ error: 'Identificativo invito non valido.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        'SELECT id, status, expires_at AS "expiresAt" FROM provider_user_invitations ' +
        'WHERE id = $1 AND provider_id = $2 FOR UPDATE',
        [invitationId.data, req.provider.providerId]
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invito non trovato.' });
      }
      const invite = found.rows[0];
      if (invite.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Solo un invito in attesa può essere revocato.' });
      }
      if (new Date(invite.expiresAt).getTime() <= Date.now()) {
        await client.query(
          "UPDATE provider_user_invitations SET status = 'expired' WHERE id = $1 AND status = 'pending'",
          [invite.id]
        );
        await client.query('COMMIT');
        return res.status(410).json({ error: 'L’invito è scaduto e non può essere revocato.' });
      }

      await client.query(
        "UPDATE provider_user_invitations SET status = 'revoked', revoked_at = NOW() " +
        "WHERE id = $1 AND provider_id = $2 AND status = 'pending'",
        [invite.id, req.provider.providerId]
      );
      await client.query(
        "INSERT INTO provider_portal_audit_log(provider_id, user_id, action, reason) " +
        "VALUES($1, $2, 'provider.invitation.revoked', 'Invito revocato dall’amministratore dell’impresa')",
        [req.provider.providerId, req.user.id]
      );
      await client.query('COMMIT');
      return res.status(200).set('Cache-Control', 'no-store').json({
        message: 'Invito revocato. Il collegamento non è più utilizzabile.',
        data: { invitationId: invite.id, status: 'revoked' }
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally {
      client.release();
    }
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


  // Provider administrators manage only memberships belonging to their verified provider.
  router.get('/members', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') {
      return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può gestire i collaboratori.' });
    }
    try {
      const result = await pool.query(
        'SELECT access.id AS "accessId", access.user_id AS "userId", ' +
        'user_account.username, user_account.display_name AS "displayName", ' +
        'user_account.active AS "accountActive", access.role, access.status, ' +
        'access.created_at AS "createdAt", access.updated_at AS "updatedAt" ' +
        'FROM provider_user_access access ' +
        'JOIN app_users user_account ON user_account.id = access.user_id ' +
        "WHERE access.provider_id = $1 AND access.status IN ('active', 'suspended') " +
        "ORDER BY CASE WHEN access.role = 'provider_admin' THEN 0 ELSE 1 END, user_account.display_name, user_account.username",
        [req.provider.providerId]
      );
      return res.status(200).set('Cache-Control', 'no-store').json({ data: result.rows });
    } catch (error) {
      return next(error);
    }
  });

  // Provider row lock serializes membership changes with invitation acceptance and
  // prevents concurrent requests from suspending the final active administrator.
  router.patch('/members/:accessId/status', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') {
      return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può modificare i collaboratori.' });
    }
    const accessId = z.string().uuid().safeParse(req.params.accessId);
    if (!accessId.success) return res.status(400).json({ error: 'Identificativo collaboratore non valido.' });
    const parsed = z.object({ status: z.enum(['active', 'suspended']) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Stato collaboratore non valido.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const provider = await client.query(
        "SELECT id FROM providers WHERE id = $1 AND status = 'verified' FOR UPDATE",
        [req.provider.providerId]
      );
      if (!provider.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Impresa verificata non trovata.' });
      }

      const found = await client.query(
        'SELECT access.id, access.user_id AS "userId", access.role, access.status, ' +
        'user_account.active AS "accountActive" ' +
        'FROM provider_user_access access JOIN app_users user_account ON user_account.id = access.user_id ' +
        'WHERE access.id = $1 AND access.provider_id = $2 FOR UPDATE OF access',
        [accessId.data, req.provider.providerId]
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Collaboratore non trovato.' });
      }

      const member = found.rows[0];
      const nextStatus = parsed.data.status;
      if (!['active', 'suspended'].includes(member.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Questo accesso non può essere modificato nello stato attuale.' });
      }
      if (nextStatus === 'active' && member.accountActive !== true) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'L’account utente è disattivato a livello di piattaforma e non può essere riattivato dal portale impresa.' });
      }
      if (member.status === nextStatus) {
        await client.query('COMMIT');
        return res.status(200).set('Cache-Control', 'no-store').json({
          message: nextStatus === 'active' ? 'Collaboratore già attivo.' : 'Collaboratore già sospeso.',
          data: { accessId: member.id, status: member.status }
        });
      }

      if (nextStatus === 'suspended' && member.role === 'provider_admin' && member.status === 'active') {
        const admins = await client.query(
          "SELECT COUNT(*)::int AS active_admins FROM provider_user_access " +
          "WHERE provider_id = $1 AND role = 'provider_admin' AND status = 'active'",
          [req.provider.providerId]
        );
        if (Number(admins.rows[0]?.active_admins || 0) <= 1) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Non puoi sospendere l’ultimo amministratore attivo dell’impresa. Nomina prima un altro amministratore.' });
        }
      }

      await client.query(
        'UPDATE provider_user_access SET status = $1, updated_at = NOW() ' +
        'WHERE id = $2 AND provider_id = $3 AND status = $4',
        [nextStatus, member.id, req.provider.providerId, member.status]
      );
      await client.query(
        'INSERT INTO provider_portal_audit_log(provider_id, user_id, action, reason) ' +
        'VALUES($1, $2, $3, $4)',
        [
          req.provider.providerId,
          req.user.id,
          nextStatus === 'suspended' ? 'provider.member.suspended' : 'provider.member.reactivated',
          'Accesso collaboratore ' + member.id + (nextStatus === 'suspended' ? ' sospeso' : ' riattivato')
        ]
      );
      await client.query('COMMIT');
      return res.status(200).set('Cache-Control', 'no-store').json({
        message: nextStatus === 'active' ? 'Accesso del collaboratore riattivato.' : 'Accesso del collaboratore sospeso.',
        data: { accessId: member.id, status: nextStatus }
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally {
      client.release();
    }
  });


  // Role changes are administrator-only and serialized to preserve one active admin.
  router.patch('/members/:accessId/role', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') {
      return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può modificare i ruoli.' });
    }
    const accessId = z.string().uuid().safeParse(req.params.accessId);
    if (!accessId.success) return res.status(400).json({ error: 'Identificativo collaboratore non valido.' });
    const parsed = z.object({ role: z.enum(['provider_admin', 'provider_operator']) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Ruolo collaboratore non valido.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const provider = await client.query(
        "SELECT id FROM providers WHERE id = $1 AND status = 'verified' FOR UPDATE",
        [req.provider.providerId]
      );
      if (!provider.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Impresa verificata non trovata.' });
      }
      const found = await client.query(
        'SELECT id, user_id AS "userId", role, status FROM provider_user_access ' +
        'WHERE id = $1 AND provider_id = $2 FOR UPDATE',
        [accessId.data, req.provider.providerId]
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Collaboratore non trovato.' });
      }
      const member = found.rows[0];
      const nextRole = parsed.data.role;
      if (!['active', 'suspended'].includes(member.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Il ruolo di questo accesso non può essere modificato nello stato attuale.' });
      }
      if (member.role === nextRole) {
        await client.query('COMMIT');
        return res.status(200).set('Cache-Control', 'no-store').json({
          message: 'Il collaboratore ha già questo ruolo.',
          data: { accessId: member.id, role: member.role, status: member.status }
        });
      }
      if (member.role === 'provider_admin' && nextRole === 'provider_operator' && member.status === 'active') {
        const admins = await client.query(
          "SELECT COUNT(*)::int AS active_admins FROM provider_user_access " +
          "WHERE provider_id = $1 AND role = 'provider_admin' AND status = 'active'",
          [req.provider.providerId]
        );
        if (Number(admins.rows[0]?.active_admins || 0) <= 1) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Non puoi declassare l’ultimo amministratore attivo. Nomina prima un altro amministratore.' });
        }
      }
      await client.query(
        'UPDATE provider_user_access SET role = $1, updated_at = NOW() ' +
        'WHERE id = $2 AND provider_id = $3 AND role = $4',
        [nextRole, member.id, req.provider.providerId, member.role]
      );
      await client.query(
        'INSERT INTO provider_portal_audit_log(provider_id, user_id, action, reason) VALUES($1, $2, $3, $4)',
        [
          req.provider.providerId,
          req.user.id,
          'provider.member.role_changed',
          'Ruolo collaboratore ' + member.id + ' modificato da ' + member.role + ' a ' + nextRole
        ]
      );
      await client.query('COMMIT');
      return res.status(200).set('Cache-Control', 'no-store').json({
        message: 'Ruolo del collaboratore aggiornato.',
        data: { accessId: member.id, role: nextRole, status: member.status }
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = createProviderPortalInvitationRouter;
