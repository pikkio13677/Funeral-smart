'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { z } = require('zod');
const scrypt = promisify(crypto.scrypt);

const ROLES = ['admin', 'manager', 'operator', 'warehouse', 'accounting'];
const ROLE_LABELS = {
  admin: 'Amministratore',
  manager: 'Responsabile',
  operator: 'Operatore',
  warehouse: 'Magazziniere',
  accounting: 'Amministrazione'
};
const SESSION_COOKIE = 'fs_session';
const SESSION_DAYS = 8;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}
async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_e) { return false; }
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const output = [];
  for (const char of input.toUpperCase().replace(/=+$/,'')) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Segreto MFA non valido.');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}
function encryptionKey() {
  const value = process.env.TOTP_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Configurazione MFA incompleta: TOTP_ENCRYPTION_KEY deve contenere 64 caratteri esadecimali.');
  return Buffer.from(value, 'hex');
}
function encryptTotpSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
}
function decryptTotpSecret(value) {
  const [version, ivHex, tagHex, dataHex] = String(value || '').split(':');
  if (version !== 'v1' || !ivHex || !tagHex || !dataHex) throw new Error('Segreto MFA non valido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
function totpCode(secret, counter) {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) | ((digest[offset + 1] & 255) << 16) | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
  return String(binary % 1000000).padStart(6, '0');
}
function verifyTotp(secret, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let delta = -1; delta <= 1; delta++) {
    const expected = Buffer.from(totpCode(secret, counter + delta));
    const supplied = Buffer.from(code);
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) return true;
  }
  return false;
}
function challengeCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 5 * 60 * 1000 };
}

function cookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 };
}

module.exports = function createAuth(pool, { sendVerificationEmail, publicAppUrl } = {}) {
  const router = express.Router();

  async function audit(user, req, action, resource = null, resourceId = null) {
    await pool.query(
      'INSERT INTO audit_log(user_id, username, action, resource, resource_id, ip_address) VALUES($1,$2,$3,$4,$5,$6)',
      [user?.id || null, user?.username || null, action, resource, resourceId, req.ip || null]
    );
  }

  async function authenticate(req, res, next) {
    try {
      const token = req.cookies?.[SESSION_COOKIE] || null;
      if (token) {
        const found = await pool.query(
          `SELECT u.id,u.username,u.display_name AS "displayName",u.role,u.active,(u.totp_enabled_at IS NOT NULL) AS "mfaEnabled"
           FROM app_sessions s JOIN app_users u ON u.id=s.user_id
           WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active=TRUE`,
          [tokenHash(token)]
        );
        if (found.rowCount) {
          req.user = found.rows[0];
          if (req.user.role === 'admin' && !req.user.mfaEnabled && !['/mfa/setup','/mfa/enable','/me','/logout'].includes(req.path)) return res.status(403).json({ error: 'Per proteggere l’account amministratore, configura prima la verifica in due passaggi.' });
          await pool.query('UPDATE app_sessions SET last_seen_at=NOW() WHERE token_hash=$1', [tokenHash(token)]);
          return next();
        }
      }

      // Compatibilità temporanea: la chiave condivisa resta valida solo finché
      // non viene creato il primo account nominativo. Poi viene disabilitata.
      const count = await pool.query('SELECT COUNT(*)::int AS total FROM app_users');
      if (count.rows[0].total === 0) {
        const supplied = req.get('x-admin-key');
        const expected = process.env.ADMIN_API_KEY;
        if (expected && safeEqual(supplied, expected)) {
          req.user = { id: null, username: 'legacy-admin', displayName: 'Accesso temporaneo', role: 'admin' };
          return next();
        }
      }
      return res.status(401).json({ error: 'Sessione non valida o scaduta. Accedi di nuovo.' });
    } catch (e) { next(e); }
  }

  function authorize(req, res, next) {
    const role = req.user?.role;
    if (role === 'admin') return next();
    const method = req.method.toUpperCase();
    const path = req.path;
    if (role === 'manager' && method === 'GET') return next();
    const allowed = {
      operator: [
        /^\/(cases|customers|tasks)(\/|$)/
      ],
      warehouse: [
        /^\/inventory(\/|$)/
      ],
      accounting: [
        /^\/invoices(\/|$)/
      ]
    };
    const permitted = (allowed[role] || []).some(pattern => pattern.test(path));
    if (permitted && ['GET', 'POST', 'PATCH'].includes(method)) return next();
    return res.status(403).json({ error: 'Non hai i permessi per questo reparto.' });
  }

  router.post('/bootstrap', async (req, res, next) => {
    const parsed = z.object({
      token: z.string().min(24).max(300),
      username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
      displayName: z.string().trim().min(2).max(160),
      password: z.string().min(12).max(200)
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati non validi. La password deve avere almeno 12 caratteri.' });
    if (!process.env.BOOTSTRAP_ADMIN_TOKEN || !safeEqual(parsed.data.token, process.env.BOOTSTRAP_ADMIN_TOKEN)) {
      return res.status(403).json({ error: 'Token iniziale non valido.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE app_users IN EXCLUSIVE MODE');
      const count = await client.query('SELECT COUNT(*)::int AS total FROM app_users');
      if (count.rows[0].total > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Amministratore iniziale già creato. Usa il login.' });
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const created = await client.query(
        "INSERT INTO app_users(username,display_name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id,username,display_name AS \"displayName\",role",
        [parsed.data.username.toLowerCase(), parsed.data.displayName, passwordHash]
      );
      await client.query('COMMIT');
      await audit(created.rows[0], req, 'bootstrap.admin.created', 'user', created.rows[0].id);
      res.status(201).json({ data: created.rows[0], message: 'Amministratore creato. Ora accedi con username e password.' });
    } catch (e) { await client.query('ROLLBACK'); if (e.code === '23505') return res.status(409).json({ error: 'Username già utilizzato.' }); next(e); }
    finally { client.release(); }
  });


  router.post('/mfa/verify-login', async (req, res, next) => {
    const parsed = z.object({ code: z.string().trim().min(6).max(32) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Inserisci il codice Authenticator o un codice di recupero.' });
    const challenge = req.cookies?.fs_mfa_challenge;
    if (!challenge) return res.status(401).json({ error: 'Verifica scaduta. Ripeti il login.' });
    try {
      const found = await pool.query(
        'SELECT c.user_id,c.attempts,u.username,u.display_name AS "displayName",u.role,u.totp_secret_enc,u.recovery_codes_hashes FROM app_mfa_challenges c JOIN app_users u ON u.id=c.user_id WHERE c.token_hash=$1 AND c.expires_at>NOW() AND u.active=TRUE',
        [tokenHash(challenge)]
      );
      if (!found.rowCount) return res.status(401).json({ error: 'Verifica scaduta. Ripeti il login.' });
      const row = found.rows[0];
      if (row.attempts >= 5) {
        await pool.query('DELETE FROM app_mfa_challenges WHERE token_hash=$1', [tokenHash(challenge)]);
        return res.status(429).json({ error: 'Troppi tentativi. Ripeti il login.' });
      }
      let valid = false;
      let usedRecoveryHash = null;
      try { valid = verifyTotp(decryptTotpSecret(row.totp_secret_enc), parsed.data.code); } catch (_e) {}
      if (!valid) {
        const candidate = parsed.data.code.replace(/\s/g, '').toUpperCase();
        const candidateHash = tokenHash(candidate);
        if ((row.recovery_codes_hashes || []).includes(candidateHash)) { valid = true; usedRecoveryHash = candidateHash; }
      }
      if (!valid) {
        await pool.query('UPDATE app_mfa_challenges SET attempts=attempts+1 WHERE token_hash=$1', [tokenHash(challenge)]);
        return res.status(401).json({ error: 'Codice non valido. Riprova.' });
      }
      if (usedRecoveryHash) await pool.query('UPDATE app_users SET recovery_codes_hashes=array_remove(recovery_codes_hashes,$1) WHERE id=$2', [usedRecoveryHash, row.user_id]);
      await pool.query('DELETE FROM app_mfa_challenges WHERE token_hash=$1', [tokenHash(challenge)]);
      const session = crypto.randomBytes(32).toString('base64url');
      await pool.query('INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+($3 || \' days\')::interval)', [row.user_id, tokenHash(session), String(SESSION_DAYS)]);
      await pool.query('UPDATE app_users SET last_login_at=NOW() WHERE id=$1', [row.user_id]);
      await audit({ id: row.user_id, username: row.username }, req, usedRecoveryHash ? 'auth.login.recovery' : 'auth.login.mfa');
      res.clearCookie('fs_mfa_challenge', challengeCookieOptions());
      res.cookie(SESSION_COOKIE, session, cookieOptions());
      res.json({ data: { id: row.user_id, username: row.username, displayName: row.displayName, role: row.role, roleLabel: ROLE_LABELS[row.role], mfaEnabled: true } });
    } catch (e) { next(e); }
  });

  router.post('/mfa/setup', authenticate, async (req, res, next) => {
    if (!req.user?.id) return res.status(403).json({ error: 'Account nominativo richiesto.' });
    if (req.user.mfaEnabled) return res.status(409).json({ error: 'La verifica in due passaggi è già attiva. Per modificarla serve una procedura di recupero amministrata.' });
    try {
      encryptionKey();
      const secret = base32Encode(crypto.randomBytes(20));
      await pool.query('UPDATE app_users SET totp_pending_secret_enc=$1 WHERE id=$2', [encryptTotpSecret(secret), req.user.id]);
      const label = encodeURIComponent('FUNERAL SMART:' + req.user.username);
      const issuer = encodeURIComponent('FUNERAL SMART');
      const otpauthUrl = 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' + issuer + '&algorithm=SHA1&digits=6&period=30';
      res.json({ secret, otpauthUrl, message: 'Aggiungi questo account alla tua app Authenticator usando la chiave segreta.' });
    } catch (e) { next(e); }
  });

  router.post('/mfa/enable', authenticate, async (req, res, next) => {
    if (!req.user?.id) return res.status(403).json({ error: 'Account nominativo richiesto.' });
    const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Inserisci il codice a 6 cifre mostrato da Authenticator.' });
    try {
      const found = await pool.query('SELECT totp_pending_secret_enc FROM app_users WHERE id=$1', [req.user.id]);
      if (!found.rowCount || !found.rows[0].totp_pending_secret_enc) return res.status(409).json({ error: 'Avvia prima la configurazione MFA.' });
      const secret = decryptTotpSecret(found.rows[0].totp_pending_secret_enc);
      if (!verifyTotp(secret, parsed.data.code)) return res.status(400).json({ error: 'Codice non corretto. Controlla l’orario del telefono e riprova.' });
      const recoveryCodes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase());
      const hashes = recoveryCodes.map(code => tokenHash(code));
      await pool.query('UPDATE app_users SET totp_secret_enc=totp_pending_secret_enc,totp_pending_secret_enc=NULL,totp_enabled_at=NOW(),recovery_codes_hashes=$1,updated_at=NOW() WHERE id=$2', [hashes, req.user.id]);
      const currentSession = req.cookies?.[SESSION_COOKIE];
      if (currentSession) await pool.query('DELETE FROM app_sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, tokenHash(currentSession)]);
      await audit(req.user, req, 'auth.mfa.enabled');
      res.json({ message: 'Verifica in due passaggi attivata. Conserva i codici di recupero: saranno mostrati una sola volta.', recoveryCodes });
    } catch (e) { next(e); }
  });

  router.post('/email/verification/request', authenticate, async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Accedi con il tuo account personale.' });
    if (typeof sendVerificationEmail !== 'function') {
      return res.status(503).json({ error: 'Verifica email non disponibile: servizio email non configurato.' });
    }
    const parsed = z.object({ email: z.string().trim().email().max(254) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Inserisci un indirizzo email valido.' });
    const email = parsed.data.email.toLowerCase();
    const client = await pool.connect();
    let challengeId;
    let code;
    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        'SELECT id, email, email_verified_at AS "emailVerifiedAt" FROM app_users WHERE id=$1 AND active=TRUE FOR UPDATE',
        [req.user.id]
      );
      if (!userResult.rowCount) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Account non attivo.' });
      }
      const user = userResult.rows[0];
      if (user.emailVerifiedAt) {
        await client.query('ROLLBACK');
        if (user.email === email) return res.json({ message: 'Questo indirizzo email è già verificato.' });
        return res.status(409).json({ error: 'L’account ha già un indirizzo email verificato. Per modificarlo serve una procedura di recupero.' });
      }
      const rate = await client.query(
        'SELECT COUNT(*)::int AS total FROM email_verification_challenges WHERE user_id=$1 AND created_at>NOW()-INTERVAL \'1 hour\'',
        [req.user.id]
      );
      if (rate.rows[0].total >= 5) {
        await client.query('ROLLBACK');
        return res.status(429).json({ error: 'Hai richiesto troppi codici. Riprova più tardi.' });
      }
      await client.query(
        'DELETE FROM email_verification_challenges WHERE user_id=$1 AND consumed_at IS NULL',
        [req.user.id]
      );
      code = String(crypto.randomInt(100000, 1000000));
      const inserted = await client.query(
        'INSERT INTO email_verification_challenges(user_id,email,code_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL \'15 minutes\') RETURNING id',
        [req.user.id, email, tokenHash(code)]
      );
      challengeId = inserted.rows[0].id;
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') return res.status(409).json({ error: 'Indirizzo email già verificato su un altro account.' });
      return next(error);
    } finally {
      client.release();
    }

    try {
      await sendVerificationEmail({ to: email, code, expiresInMinutes: 15 });
      return res.status(202).json({ message: 'Codice inviato. Controlla la posta e inseriscilo entro 15 minuti.' });
    } catch (_error) {
      try {
        await pool.query(
          'DELETE FROM email_verification_challenges WHERE id=$1 AND consumed_at IS NULL',
          [challengeId]
        );
      } catch (_) {}
      return res.status(503).json({ error: 'Invio del codice non riuscito. Riprova più tardi.' });
    }
  });

  router.post('/email/verification/confirm', authenticate, async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Accedi con il tuo account personale.' });
    const parsed = z.object({ code: z.string().trim().regex(/^\\d{6}$/) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Inserisci il codice a 6 cifre ricevuto via email.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const challengeResult = await client.query(
        `SELECT id, email, code_hash, attempts
         FROM email_verification_challenges
         WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>NOW()
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [req.user.id]
      );
      if (!challengeResult.rowCount) {
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'Codice scaduto o non disponibile. Richiedine uno nuovo.' });
      }
      const challenge = challengeResult.rows[0];
      if (challenge.attempts >= 5) {
        await client.query(
          'UPDATE email_verification_challenges SET consumed_at=NOW() WHERE id=$1',
          [challenge.id]
        );
        await client.query('COMMIT');
        return res.status(429).json({ error: 'Troppi tentativi. Richiedi un nuovo codice.' });
      }
      if (!safeEqual(challenge.code_hash, tokenHash(parsed.data.code))) {
        await client.query(
          'UPDATE email_verification_challenges SET attempts=attempts+1 WHERE id=$1',
          [challenge.id]
        );
        await client.query('COMMIT');
        return res.status(400).json({ error: 'Codice non corretto.' });
      }
      const updated = await client.query(
        `UPDATE app_users
         SET email=$1, email_verified_at=NOW(), updated_at=NOW()
         WHERE id=$2 AND active=TRUE AND email_verified_at IS NULL
         RETURNING id, email, email_verified_at AS "emailVerifiedAt"`,
        [challenge.email, req.user.id]
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Indirizzo email già verificato o account non attivo.' });
      }
      await client.query(
        'UPDATE email_verification_challenges SET consumed_at=NOW() WHERE id=$1',
        [challenge.id]
      );
      await client.query('COMMIT');
      return res.json({ data: updated.rows[0], message: 'Indirizzo email verificato correttamente.' });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') return res.status(409).json({ error: 'Questo indirizzo email è già verificato su un altro account.' });
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/login', async (req, res, next) => {
    const parsed = z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Inserisci username e password.' });
    try {
      const result = await pool.query('SELECT id,username,display_name AS "displayName",password_hash,role,active,totp_enabled_at FROM app_users WHERE username=$1', [parsed.data.username.toLowerCase()]);
      const user = result.rows[0];
      if (!user || !user.active || !(await verifyPassword(parsed.data.password, user.password_hash))) {
        return res.status(401).json({ error: 'Credenziali non corrette.' });
      }
      if (user.totp_enabled_at) {
        await pool.query('DELETE FROM app_mfa_challenges WHERE expires_at<NOW()');
        const challenge = crypto.randomBytes(32).toString('base64url');
        await pool.query("INSERT INTO app_mfa_challenges(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '5 minutes')", [user.id, tokenHash(challenge)]);
        res.cookie('fs_mfa_challenge', challenge, challengeCookieOptions());
        return res.json({ mfaRequired: true, message: 'Inserisci il codice a 6 cifre della tua app Authenticator.' });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query('INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+($3 || \' days\')::interval)', [user.id, tokenHash(token), String(SESSION_DAYS)]);
      await pool.query('UPDATE app_users SET last_login_at=NOW() WHERE id=$1', [user.id]);
      await audit(user, req, 'auth.login');
      res.cookie(SESSION_COOKIE, token, cookieOptions());
      res.json({ data: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, roleLabel: ROLE_LABELS[user.role], mfaEnabled: false } });
    } catch (e) { next(e); }
  });

  router.post('/logout', authenticate, async (req, res, next) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [tokenHash(token)]);
      await audit(req.user, req, 'auth.logout');
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
      res.json({ message: 'Sessione terminata.' });
    } catch (e) { next(e); }
  });

  router.get('/me', authenticate, (req, res) => {
    res.json({ data: { id: req.user.id, username: req.user.username, displayName: req.user.displayName, role: req.user.role, roleLabel: ROLE_LABELS[req.user.role] || 'Accesso temporaneo', mfaEnabled: Boolean(req.user.mfaEnabled) } });
  });

  router.get('/users', authenticate, async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo l’amministratore può gestire gli utenti.' });
    try {
      const result = await pool.query('SELECT id,username,display_name AS "displayName",role,active,created_at AS "createdAt",last_login_at AS "lastLoginAt" FROM app_users ORDER BY created_at DESC');
      res.json({ data: result.rows, roles: ROLE_LABELS });
    } catch (e) { next(e); }
  });

  router.post('/users', authenticate, async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo l’amministratore può creare utenti.' });
    const parsed = z.object({
      username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
      displayName: z.string().trim().min(2).max(160),
      password: z.string().min(12).max(200),
      role: z.enum(ROLES.filter(r => r !== 'admin'))
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati non validi. Username 3-60 caratteri e password almeno 12 caratteri.' });
    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const result = await pool.query(
        'INSERT INTO app_users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,display_name AS "displayName",role,active,created_at AS "createdAt"',
        [parsed.data.username.toLowerCase(), parsed.data.displayName, passwordHash, parsed.data.role]
      );
      await audit(req.user, req, 'user.created', 'user', result.rows[0].id);
      res.status(201).json({ data: result.rows[0] });
    } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username già utilizzato.' }); next(e); }
  });

  router.patch('/users/:id/active', authenticate, async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo l’amministratore può modificare gli utenti.' });
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Stato utente non valido.' });
    if (req.params.id === req.user.id && !parsed.data.active) return res.status(400).json({ error: 'Non puoi disattivare il tuo account mentre sei collegato.' });
    try {
      const result = await pool.query('UPDATE app_users SET active=$1,updated_at=NOW() WHERE id=$2 RETURNING id,username,active', [parsed.data.active, req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: 'Utente non trovato.' });
      if (!parsed.data.active) await pool.query('DELETE FROM app_sessions WHERE user_id=$1', [req.params.id]);
      await audit(req.user, req, parsed.data.active ? 'user.activated' : 'user.deactivated', 'user', req.params.id);
      res.json({ data: result.rows[0] });
    } catch (e) { next(e); }
  });

  return { router, authenticate, authorize };
};
