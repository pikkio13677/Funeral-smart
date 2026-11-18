-- FUNERAL SMART — bozza migrazione 015: accesso portale imprese
-- STAGED / NON ESEGUITA. Dipende da schema marketplace e assegnazioni 014.
-- Non aggiungere a migrate.js e non eseguire su Render/produzione senza approvazione.
-- Le imprese marketplace sono distinte dalle aziende SaaS (companies/company_memberships).

CREATE TABLE IF NOT EXISTS provider_user_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role VARCHAR(24) NOT NULL DEFAULT 'provider_operator'
    CHECK (role IN ('provider_admin', 'provider_operator')),
  status VARCHAR(20) NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'suspended', 'revoked')),
  invited_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_user_access_user_status
  ON provider_user_access(user_id, status);
CREATE INDEX IF NOT EXISTS idx_provider_user_access_provider_status
  ON provider_user_access(provider_id, status);

CREATE TABLE IF NOT EXISTS provider_user_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  email VARCHAR(254) NOT NULL,
  role VARCHAR(24) NOT NULL DEFAULT 'provider_operator'
    CHECK (role IN ('provider_admin', 'provider_operator')),
  token_hash CHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  accepted_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK ((status = 'accepted' AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
      OR status <> 'accepted')
);
CREATE INDEX IF NOT EXISTS idx_provider_user_invitations_provider_status
  ON provider_user_invitations(provider_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_user_invitations_expiry
  ON provider_user_invitations(expires_at) WHERE status = 'pending';

-- Risposta dell'impresa all'incarico. Una sola risposta per assegnazione.
-- I dati di contatto della famiglia restano nascosti finché status='accepted'.
CREATE TABLE IF NOT EXISTS provider_inquiry_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL UNIQUE
    REFERENCES inquiry_provider_assignments(id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('accepted', 'rejected')),
  reason VARCHAR(500) NOT NULL,
  responded_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(trim(reason)) >= 10)
);
CREATE INDEX IF NOT EXISTS idx_provider_inquiry_responses_provider
  ON provider_inquiry_responses(provider_id, responded_at DESC);

-- Registro separato: non contiene note della famiglia, email o telefono.
CREATE TABLE IF NOT EXISTS provider_portal_audit_log (
  id BIGSERIAL PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  assignment_id UUID REFERENCES inquiry_provider_assignments(id) ON DELETE RESTRICT,
  action VARCHAR(100) NOT NULL,
  reason VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_provider_portal_audit_provider_created
  ON provider_portal_audit_log(provider_id, created_at DESC, id DESC);

-- Nessun backfill automatico degli account: gli accessi devono essere creati
-- esclusivamente da un invito verificato. Nessun collegamento automatico per email.
-- Le API devono ricavare provider_id dal record provider_user_access attivo,
-- mai da un parametro controllato dal browser.

-- Difesa referenziale: una risposta o un evento audit non può attribuire
-- un incarico all'ID di un'altra impresa. L'ID assegnazione è già PK;
-- questo indice univoco abilita la FK composta richiesta dal modello.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiry_provider_assignments_id_provider
  ON inquiry_provider_assignments(id, provider_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.provider_inquiry_responses'::regclass
      AND conname = 'fk_provider_response_assignment_provider'
  ) THEN
    ALTER TABLE provider_inquiry_responses
      ADD CONSTRAINT fk_provider_response_assignment_provider
      FOREIGN KEY (assignment_id, provider_id)
      REFERENCES inquiry_provider_assignments(id, provider_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.provider_portal_audit_log'::regclass
      AND conname = 'fk_provider_audit_assignment_provider'
  ) THEN
    ALTER TABLE provider_portal_audit_log
      ADD CONSTRAINT fk_provider_audit_assignment_provider
      FOREIGN KEY (assignment_id, provider_id)
      REFERENCES inquiry_provider_assignments(id, provider_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- L'email viene normalizzata dall'API prima dell'inserimento; il vincolo
-- protegge anche da scritture alternative o future regressioni.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.provider_user_invitations'::regclass
      AND conname = 'ck_provider_invitation_email_normalized'
  ) THEN
    ALTER TABLE provider_user_invitations
      ADD CONSTRAINT ck_provider_invitation_email_normalized
      CHECK (email = lower(btrim(email)));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.provider_user_invitations'::regclass
      AND conname = 'ck_provider_invitation_state_timestamps'
  ) THEN
    ALTER TABLE provider_user_invitations
      ADD CONSTRAINT ck_provider_invitation_state_timestamps
      CHECK (
        (status = 'accepted'
          AND accepted_at IS NOT NULL
          AND accepted_by_user_id IS NOT NULL
          AND revoked_at IS NULL)
        OR
        (status = 'revoked'
          AND revoked_at IS NOT NULL
          AND accepted_at IS NULL
          AND accepted_by_user_id IS NULL)
        OR
        (status IN ('pending', 'expired')
          AND accepted_at IS NULL
          AND accepted_by_user_id IS NULL
          AND revoked_at IS NULL)
      );
  END IF;
END $$;

