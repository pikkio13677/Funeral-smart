-- FUNERAL SMART: autenticazione a due fattori TOTP e codici di recupero.
-- Migrazione additiva: non modifica i dati gestionali o gli account esistenti.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS totp_pending_secret_enc TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS recovery_codes_hashes TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS app_mfa_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_mfa_challenges_expiry ON app_mfa_challenges(expires_at);
