'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const createProviderContext = require('./context');

const uuid = z.string().uuid();
const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(['provider_admin', 'provider_operator'])
}).strict();
const acceptSchema = z.object({ token: z.string().min(32).max(200) }).strict();

const normalizeEmail = value => value.trim().toLowerCase();
const hashToken = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function createMariaDbProviderInvitationRouter(database, options = {}) {
  if (!database || typeof database.query !== 'function' || typeof database.withTransaction !== 'function') {
    throw new TypeError('A MariaDB database adapter with query() and withTransaction() is required.');
  }
  if (typeof options.authenticate !== 'function') throw new TypeError('Authentication middleware is required.');

  const router = express.Router();
  const providerContext = createProviderContext(database);
  router.use(options.authenticate);

  async function createInvitation(providerId, req, res, next) {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Indirizzo email o ruolo non validi.' });
    if (typeof options.sendInvitationEmail !== 'function' || !options.publicAppUrl) {
      return res.status(503).json({ error: 'Inviti temporaneamente non disponibili: servizio email non configurato.' });
    }

    let baseUrl;
    try {
      baseUrl = new URL(options.publicAppUrl);
      if (baseUrl.protocol !== 'https:') throw new Error('HTTPS required');
    } catch (_) {
      return res.status(503).json({ error: 'Indirizzo pubblico HTTPS non configurato correttamente.' });
    }

    const email = normalizeEmail(parsed.data.email);
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    let created;
    try {
      created = await database.withTransaction(async connection => {
        const [providers] = await connection.execute(
          "SELECT business_name AS businessName FROM providers WHERE id = ? AND status = 'verified' FOR UPDATE",
          [providerId]
        );
        if (!providers.length) return { status: 404, body: { error: 'Impresa verificata non trovata.' } };

        const [active] = await connection.execute(
          "SELECT access.id FROM provider_user_access access JOIN app_users u ON u.id = access.user_id WHERE access.provider_id = ? AND LOWER(u.email) = ? AND access.status = 'active' LIMIT 1",
          [providerId, email]
        );
        if (active.length) return { status: 409, body: { error: 'Questo indirizzo appartiene già a un utente attivo dell’impresa.' } };

        const [pending] = await connection.execute(
          "SELECT id FROM provider_user_invitations WHERE provider_id = ? AND LOWER(email) = ? AND status = 'pending' AND expires_at > UTC_TIMESTAMP(3) LIMIT 1",
          [providerId, email]
        );
        if (pending.length) return { status: 409, body: { error: 'Esiste già un invito in attesa per questo indirizzo.' } };

        await connection.execute(
          "INSERT INTO provider_user_invitations (id, provider_id, email, role, token_hash, invited_by_user_id, status, created_at, expires_at) VALUES (UUID(), ?, ?, ?, ?, ?, 'pending', UTC_TIMESTAMP(3), ?)",
          [providerId, email, parsed.data.role, tokenHash, req.user.id, expiresAt]
        );
        const [rows] = await connection.execute(
          'SELECT id FROM provider_user_invitations WHERE provider_id = ? AND token_hash = ? LIMIT 1',
          [providerId, tokenHash]
        );
        return { status: 201, id: rows[0].id, businessName: providers[0].businessName };
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esiste già un invito o un accesso per questo indirizzo.' });
      return next(error);
    }
    if (created.status !== 201) return res.status(created.status).json(created.body);

    const invitationUrl = new URL('/provider/invito/accetta', baseUrl);
    invitationUrl.searchParams.set('token', token);
    try {
      await options.sendInvitationEmail({
        to: email, businessName: created.businessName,
        invitationUrl: invitationUrl.toString(), expiresAt, role: parsed.data.role
      });
    } catch (_) {
      try {
        await database.query(
          "UPDATE provider_user_invitations SET status = 'revoked', revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'pending'",
          [created.id]
        );
      } catch (_) {}
      return res.status(503).json({ error: 'Invito non inviato. È stato annullato: riprova più tardi.' });
    }
    return res.status(201).json({
      message: 'Invito inviato. Il collegamento è valido per 72 ore.',
      data: { invitationId: created.id, email, role: parsed.data.role, expiresAt }
    });
  }

  router.post('/providers/:providerId/invitations', async (req, res, next) => {
    if (!['admin', 'platform_owner'].includes(req.user?.role)) {
      return res.status(403).json({ error: 'Solo un amministratore della piattaforma può attivare il primo accesso dell’impresa.' });
    }
    const id = uuid.safeParse(req.params.providerId);
    if (!id.success) return res.status(400).json({ error: 'Identificativo impresa non valido.' });
    return createInvitation(id.data, req, res, next);
  });

  router.post('/invitations', providerContext, (req, res, next) => {
    if (req.provider.role !== 'provider_admin') return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può invitare collaboratori.' });
    return createInvitation(req.provider.providerId, req, res, next);
  });

  router.get('/invitations', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può gestire gli inviti.' });
    try {
      const [rows] = await database.query(
        "SELECT id, email, role, CASE WHEN status = 'pending' AND expires_at <= UTC_TIMESTAMP(3) THEN 'expired' ELSE status END AS status, created_at AS createdAt, expires_at AS expiresAt, accepted_at AS acceptedAt, revoked_at AS revokedAt FROM provider_user_invitations WHERE provider_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
        [req.provider.providerId]
      );
      return res.status(200).set('Cache-Control', 'no-store').json({ data: rows });
    } catch (error) { return next(error); }
  });

  router.delete('/invitations/:invitationId', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può revocare gli inviti.' });
    const id = uuid.safeParse(req.params.invitationId);
    if (!id.success) return res.status(400).json({ error: 'Identificativo invito non valido.' });
    try {
      const result = await database.withTransaction(async connection => {
        const [rows] = await connection.execute(
          'SELECT id, status, expires_at AS expiresAt, (expires_at <= UTC_TIMESTAMP(3)) AS isExpired FROM provider_user_invitations WHERE id = ? AND provider_id = ? FOR UPDATE',
          [id.data, req.provider.providerId]
        );
        if (!rows.length) return { status: 404, body: { error: 'Invito non trovato.' } };
        const invite = rows[0];
        if (invite.status !== 'pending') return { status: 409, body: { error: 'Solo un invito in attesa può essere revocato.' } };
        if (Number(invite.isExpired) === 1) {
          await connection.execute("UPDATE provider_user_invitations SET status = 'expired' WHERE id = ? AND provider_id = ? AND status = 'pending'", [invite.id, req.provider.providerId]);
          return { status: 410, body: { error: 'L’invito è scaduto e non può essere revocato.' } };
        }
        await connection.execute("UPDATE provider_user_invitations SET status = 'revoked', revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND provider_id = ? AND status = 'pending'", [invite.id, req.provider.providerId]);
        await connection.execute("INSERT INTO provider_portal_audit_log (provider_id, user_id, action, reason, created_at) VALUES (?, ?, 'provider.invitation.revoked', 'Invito revocato dall’amministratore dell’impresa', UTC_TIMESTAMP(3))", [req.provider.providerId, req.user.id]);
        return { status: 200, body: { message: 'Invito revocato. Il collegamento non è più utilizzabile.', data: { invitationId: invite.id, status: 'revoked' } } };
      });
      return res.status(result.status).set('Cache-Control', 'no-store').json(result.body);
    } catch (error) { return next(error); }
  });

  // No email-based auto-linking: the signed-in account must own the verified invited address.
  router.post('/invitations/accept', async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Accedi con il tuo account prima di accettare l’invito.' });
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Link di invito non valido.' });
    try {
      const result = await database.withTransaction(async connection => {
        const [invites] = await connection.execute(
          'SELECT id, provider_id AS providerId, email, role, status, expires_at AS expiresAt, (expires_at <= UTC_TIMESTAMP(3)) AS isExpired, invited_by_user_id AS invitedByUserId FROM provider_user_invitations WHERE token_hash = ? FOR UPDATE',
          [hashToken(parsed.data.token)]
        );
        if (!invites.length || invites[0].status !== 'pending') return { status: 400, body: { error: 'Invito non valido, revocato o già utilizzato.' } };
        const invite = invites[0];
        if (Number(invite.isExpired) === 1) {
          await connection.execute("UPDATE provider_user_invitations SET status = 'expired' WHERE id = ? AND status = 'pending'", [invite.id]);
          return { status: 410, body: { error: 'Invito scaduto. Chiedi all’impresa di inviarne uno nuovo.' } };
        }
        const [users] = await connection.execute(
          'SELECT id, email, email_verified_at AS emailVerifiedAt, active FROM app_users WHERE id = ? FOR UPDATE',
          [req.user.id]
        );
        if (!users.length || Number(users[0].active) !== 1) return { status: 401, body: { error: 'Account non attivo.' } };
        const user = users[0];
        if (!user.email || !user.emailVerifiedAt || normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
          return { status: 403, body: { error: 'Accedi con un account che abbia l’indirizzo email dell’invito verificato.' } };
        }
        const [providers] = await connection.execute("SELECT id FROM providers WHERE id = ? AND status = 'verified' FOR UPDATE", [invite.providerId]);
        if (!providers.length) return { status: 409, body: { error: 'L’impresa non è più verificata e l’invito non può essere accettato.' } };
        const [existing] = await connection.execute('SELECT id FROM provider_user_access WHERE provider_id = ? AND user_id = ? FOR UPDATE', [invite.providerId, req.user.id]);
        if (existing.length) return { status: 409, body: { error: 'Questo account ha già un accesso registrato per l’impresa.' } };

        await connection.execute(
          "INSERT INTO provider_user_access (id, provider_id, user_id, role, status, invited_by_user_id, created_at, updated_at) VALUES (UUID(), ?, ?, ?, 'active', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
          [invite.providerId, req.user.id, invite.role, invite.invitedByUserId || null]
        );
        const [access] = await connection.execute('SELECT id FROM provider_user_access WHERE provider_id = ? AND user_id = ? LIMIT 1', [invite.providerId, req.user.id]);
        await connection.execute("UPDATE provider_user_invitations SET status = 'accepted', accepted_at = UTC_TIMESTAMP(3), accepted_by_user_id = ? WHERE id = ? AND status = 'pending'", [req.user.id, invite.id]);
        await connection.execute("INSERT INTO provider_portal_audit_log (provider_id, user_id, action, reason, created_at) VALUES (?, ?, 'provider.invitation.accepted', 'Accesso attivato tramite invito verificato', UTC_TIMESTAMP(3))", [invite.providerId, req.user.id]);
        return { status: 201, body: { message: 'Invito accettato. Ora puoi accedere al portale dell’impresa.', data: { accessId: access[0].id, providerId: invite.providerId, role: invite.role } } };
      });
      return res.status(result.status).set('Cache-Control', 'no-store').json(result.body);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Questo accesso è già stato attivato.' });
      return next(error);
    }
  });

  router.get('/members', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può gestire i collaboratori.' });
    try {
      const [rows] = await database.query(
        "SELECT a.id AS accessId, a.user_id AS userId, u.username, u.display_name AS displayName, u.active AS accountActive, a.role, a.status, a.created_at AS createdAt, a.updated_at AS updatedAt FROM provider_user_access a JOIN app_users u ON u.id = a.user_id WHERE a.provider_id = ? AND a.status IN ('active', 'suspended') ORDER BY CASE WHEN a.role = 'provider_admin' THEN 0 ELSE 1 END, u.display_name, u.username",
        [req.provider.providerId]
      );
      return res.status(200).set('Cache-Control', 'no-store').json({ data: rows });
    } catch (error) { return next(error); }
  });

  router.patch('/members/:accessId/status', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può modificare i collaboratori.' });
    const id = uuid.safeParse(req.params.accessId);
    const parsed = z.object({ status: z.enum(['active', 'suspended']) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Stato o identificativo collaboratore non validi.' });
    try {
      const result = await database.withTransaction(async connection => {
        const [providers] = await connection.execute("SELECT id FROM providers WHERE id = ? AND status = 'verified' FOR UPDATE", [req.provider.providerId]);
        if (!providers.length) return { status: 404, body: { error: 'Impresa verificata non trovata.' } };
        const [rows] = await connection.execute(
          'SELECT a.id, a.role, a.status, u.active AS accountActive FROM provider_user_access a JOIN app_users u ON u.id = a.user_id WHERE a.id = ? AND a.provider_id = ? FOR UPDATE',
          [id.data, req.provider.providerId]
        );
        if (!rows.length) return { status: 404, body: { error: 'Collaboratore non trovato.' } };
        const member = rows[0], nextStatus = parsed.data.status;
        if (!['active', 'suspended'].includes(member.status)) return { status: 409, body: { error: 'Questo accesso non può essere modificato nello stato attuale.' } };
        if (nextStatus === 'active' && Number(member.accountActive) !== 1) return { status: 409, body: { error: 'L’account utente è disattivato a livello di piattaforma e non può essere riattivato dal portale impresa.' } };
        if (member.status === nextStatus) return { status: 200, body: { message: nextStatus === 'active' ? 'Collaboratore già attivo.' : 'Collaboratore già sospeso.', data: { accessId: id.data, status: member.status } } };
        if (nextStatus === 'suspended' && member.role === 'provider_admin' && member.status === 'active') {
          const [counts] = await connection.execute("SELECT COUNT(*) AS activeAdmins FROM provider_user_access WHERE provider_id = ? AND role = 'provider_admin' AND status = 'active'", [req.provider.providerId]);
          if (Number(counts[0]?.activeAdmins || 0) <= 1) return { status: 409, body: { error: 'Non puoi sospendere l’ultimo amministratore attivo dell’impresa. Nomina prima un altro amministratore.' } };
        }
        await connection.execute('UPDATE provider_user_access SET status = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND provider_id = ? AND status = ?', [nextStatus, id.data, req.provider.providerId, member.status]);
        await connection.execute('INSERT INTO provider_portal_audit_log (provider_id, user_id, action, reason, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))', [req.provider.providerId, req.user.id, nextStatus === 'suspended' ? 'provider.member.suspended' : 'provider.member.reactivated', 'Accesso collaboratore ' + id.data + (nextStatus === 'suspended' ? ' sospeso' : ' riattivato')]);
        return { status: 200, body: { message: nextStatus === 'active' ? 'Accesso del collaboratore riattivato.' : 'Accesso del collaboratore sospeso.', data: { accessId: id.data, status: nextStatus } } };
      });
      return res.status(result.status).set('Cache-Control', 'no-store').json(result.body);
    } catch (error) { return next(error); }
  });

  router.patch('/members/:accessId/role', providerContext, async (req, res, next) => {
    if (req.provider.role !== 'provider_admin') return res.status(403).json({ error: 'Solo l’amministratore dell’impresa può modificare i ruoli.' });
    const id = uuid.safeParse(req.params.accessId);
    const parsed = z.object({ role: z.enum(['provider_admin', 'provider_operator']) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Ruolo o identificativo collaboratore non validi.' });
    try {
      const result = await database.withTransaction(async connection => {
        const [providers] = await connection.execute("SELECT id FROM providers WHERE id = ? AND status = 'verified' FOR UPDATE", [req.provider.providerId]);
        if (!providers.length) return { status: 404, body: { error: 'Impresa verificata non trovata.' } };
        const [rows] = await connection.execute('SELECT id, role, status FROM provider_user_access WHERE id = ? AND provider_id = ? FOR UPDATE', [id.data, req.provider.providerId]);
        if (!rows.length) return { status: 404, body: { error: 'Collaboratore non trovato.' } };
        const member = rows[0], nextRole = parsed.data.role;
        if (!['active', 'suspended'].includes(member.status)) return { status: 409, body: { error: 'Il ruolo di questo accesso non può essere modificato nello stato attuale.' } };
        if (member.role === nextRole) return { status: 200, body: { message: 'Il collaboratore ha già questo ruolo.', data: { accessId: id.data, role: member.role, status: member.status } } };
        if (member.role === 'provider_admin' && nextRole === 'provider_operator' && member.status === 'active') {
          const [counts] = await connection.execute("SELECT COUNT(*) AS activeAdmins FROM provider_user_access WHERE provider_id = ? AND role = 'provider_admin' AND status = 'active'", [req.provider.providerId]);
          if (Number(counts[0]?.activeAdmins || 0) <= 1) return { status: 409, body: { error: 'Non puoi declassare l’ultimo amministratore attivo. Nomina prima un altro amministratore.' } };
        }
        await connection.execute('UPDATE provider_user_access SET role = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND provider_id = ? AND role = ?', [nextRole, id.data, req.provider.providerId, member.role]);
        await connection.execute("INSERT INTO provider_portal_audit_log (provider_id, user_id, action, reason, created_at) VALUES (?, ?, 'provider.member.role_changed', ?, UTC_TIMESTAMP(3))", [req.provider.providerId, req.user.id, 'Ruolo collaboratore ' + id.data + ' modificato da ' + member.role + ' a ' + nextRole]);
        return { status: 200, body: { message: 'Ruolo del collaboratore aggiornato.', data: { accessId: id.data, role: nextRole, status: member.status } } };
      });
      return res.status(result.status).set('Cache-Control', 'no-store').json(result.body);
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = createMariaDbProviderInvitationRouter;
