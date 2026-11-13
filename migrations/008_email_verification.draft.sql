-- FUNERAL SMART — bozza migrazione 008: codici di verifica email
-- Dipende da 007_audit_invitations.draft.sql (app_users.email).
-- NON aggiungere a migrate.js e NON applicare a produzione prima del rollout completo.
-- I codici in chiaro vengono inviati una sola volta e nel DB resta solo SHA-256.

CREATE TABLE IF NOT EXISTS email_verification_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  email VARCHAR(254) NOT NULL,
  code_hash CHAR(64) NOT NULL
    CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  attempts SMALLINT NOT NULL DEFAULT 0
    CHECK (attempts BETWEEN 0 AND 5),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (email = lower(btrim(email))),
  CHECK (expires_at > created_at)
);

-- Un solo codice pendente per account; le righe consumate restano per rate limiting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_verification_pending_user
  ON email_verification_challenges(user_id)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_verification_user_created
  ON email_verification_challenges(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_verification_expiry
  ON email_verification_challenges(expires_at)
  WHERE consumed_at IS NULL;
