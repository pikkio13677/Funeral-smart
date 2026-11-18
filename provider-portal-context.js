'use strict';

function createProviderContext(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }

  return async function providerContext(req, res, next) {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Autenticazione richiesta.' });
    }

    try {
      // Resolve the provider exclusively from the authenticated user ID.
      // Never accept providerId from a route parameter, header, cookie or body.
      const result = await pool.query(
        `SELECT access.provider_id AS "providerId",
                access.role,
                provider.business_name AS "businessName"
         FROM provider_user_access access
         JOIN providers provider ON provider.id = access.provider_id
         WHERE access.user_id = $1
           AND access.status = 'active'
           AND provider.status = 'verified'
         ORDER BY access.created_at, access.id
         LIMIT 2`,
        [req.user.id]
      );

      if (!result.rowCount) {
        return res.status(403).json({ error: 'Non hai un accesso attivo a un’impresa verificata.' });
      }
      if (result.rowCount > 1) {
        // Multi-provider switching is intentionally not implicit. It needs a
        // separately designed server-validated selection flow.
        return res.status(409).json({ error: 'Questo account è collegato a più imprese. Selezione impresa non ancora disponibile.' });
      }

      const access = result.rows[0];
      if (!['provider_admin', 'provider_operator'].includes(access.role)) {
        return res.status(403).json({ error: 'Ruolo portale non valido.' });
      }

      req.provider = Object.freeze({
        providerId: access.providerId,
        role: access.role,
        businessName: access.businessName
      });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = createProviderContext;
