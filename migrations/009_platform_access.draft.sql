-- FUNERAL SMART — bozza migrazione 009: identità della piattaforma
-- STAGED / NON ESEGUITA: NON inserirla in migrate.js e NON applicarla a DATABASE_URL.
-- Questa tabella è separata dai ruoli aziendali in app_users.role e company_memberships.role.
-- Nessun utente viene promosso automaticamente: il bootstrap del proprietario richiede una procedura separata e controllata.

CREATE TABLE IF NOT EXISTS platform_access (
  user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  role VARCHAR(24) NOT NULL
    CHECK (role IN ('owner', 'support')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  granted_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes VARCHAR(500)
);

CREATE INDEX IF NOT EXISTS idx_platform_access_status_role
  ON platform_access(status, role);

-- Invarianti:
-- 1. app_users.role='admin' NON concede privilegi di piattaforma.
-- 2. company_memberships.role descrive solo i permessi dentro una singola azienda.
-- 3. Solo una riga platform_access attiva concede un ruolo centrale.
-- 4. Il platform owner non riceve una company o membership fittizia.
-- 5. L'accesso di assistenza ai dati aziendali, se previsto, dovrà essere temporaneo,
--    esplicito, limitato e registrato in audit; non è implicito nel ruolo support.
