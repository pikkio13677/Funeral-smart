'use strict';

/**
 * Resolve a verified provider exclusively from the authenticated user.
 * MariaDB implementation kept separate from the existing PostgreSQL middleware.
 */
function createMariaDbProviderContext(database) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('A MariaDB database adapter with query() is required.');
  }

  return async function mariaDbProviderContext(req, res, next) {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Autenticazione richiesta.' });
    }

    try {
      const [rows] = await database.query(
        `SELECT access.provider_id AS providerId,
                access.role,
                provider.business_name AS businessName
         FROM provider_user_access access
         JOIN providers provider ON provider.id = access.provider_id
         WHERE access.user_id = ?
           AND access.status = 'active'
           AND provider.status = 'verified'
         ORDER BY access.created_at, access.id
         LIMIT 2`,
        [req.user.id]
      );

      if (!rows.length) {
        return res.status(403).json({ error: 'Non hai un accesso attivo a un’impresa verificata.' });
      }
      if (rows.length > 1) {
        return res.status(409).json({ error: 'Questo account è collegato a più imprese. Selezione impresa non ancora disponibile.' });
      }

      const access = rows[0];
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

module.exports = createMariaDbProviderContext;
