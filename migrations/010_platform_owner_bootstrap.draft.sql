-- FUNERAL SMART — bozza migrazione 010: bootstrap proprietario piattaforma
-- STAGED / NON ESEGUITA. Richiede 009_platform_access.draft.sql.
-- Aggiunge un ruolo applicativo isolato: non è admin aziendale e non riceve membership.
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users
  ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('admin','manager','operator','warehouse','accounting','platform_owner'));

-- Stato singleton per rendere il bootstrap consumabile una sola volta,
-- anche se esistono già account aziendali legacy.
CREATE TABLE IF NOT EXISTS platform_bootstrap_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  consumed_at TIMESTAMPTZ,
  consumed_by UUID REFERENCES app_users(id) ON DELETE SET NULL
);

INSERT INTO platform_bootstrap_state(singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- Un solo proprietario attivo; gli account support possono essere multipli.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_access_single_active_owner
  ON platform_access(role)
  WHERE role = 'owner' AND status = 'active';
