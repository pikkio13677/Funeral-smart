-- FUNERAL SMART — bozza migrazione 007: audit tenant e inviti aziendali
-- DESIGN STAGED / NON ESEGUITA.
-- Dipende da 005_multi_tenant_foundation.draft.sql.
-- NON registrare in migrate.js e NON applicare a Render/produzione.
-- Richiede backup verificato, restore-test e revisione del rollout.

BEGIN;

-- Le FK composte rendono impossibile associare un evento/invito a una membership
-- appartenente a un'altra azienda o a un altro utente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_memberships_id_company_user
  ON company_memberships(id, company_id, user_id);

-- Target univoco necessario alla FK invitante (membership + azienda).
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_memberships_id_company
  ON company_memberships(id, company_id);

-- Email dell'identità globale: viene verificata solo quando l'utente
-- accetta un invito ricevuto a quell'indirizzo. Nessun indirizzo è inventato
-- o importato dagli account preesistenti.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS email VARCHAR(254),
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_app_users_email_normalized'
      AND conrelid = 'public.app_users'::regclass
  ) THEN
    ALTER TABLE app_users
      ADD CONSTRAINT ck_app_users_email_normalized
      CHECK (email IS NULL OR email = lower(btrim(email)));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_app_users_email_verification_requires_email'
      AND conrelid = 'public.app_users'::regclass
  ) THEN
    ALTER TABLE app_users
      ADD CONSTRAINT ck_app_users_email_verification_requires_email
      CHECK (email_verified_at IS NULL OR email IS NOT NULL);
  END IF;
END $;

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_verified_email
  ON app_users(email)
  WHERE email_verified_at IS NOT NULL;

-- Audit globale già esistente: gli eventi storici rimangono con company_id NULL.
-- Gli eventi aziendali futuri devono valorizzare company_id, membership_id e user_id.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS company_id UUID,
  ADD COLUMN IF NOT EXISTS membership_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_audit_log_tenant_membership'
      AND conrelid = 'public.audit_log'::regclass
  ) THEN
    ALTER TABLE audit_log
      ADD CONSTRAINT fk_audit_log_tenant_membership
      FOREIGN KEY (membership_id, company_id, user_id)
      REFERENCES company_memberships(id, company_id, user_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_audit_log_tenant_context_consistent'
      AND conrelid = 'public.audit_log'::regclass
  ) THEN
    ALTER TABLE audit_log
      ADD CONSTRAINT ck_audit_log_tenant_context_consistent
      CHECK (
        (company_id IS NULL AND membership_id IS NULL)
        OR
        (company_id IS NOT NULL AND membership_id IS NOT NULL AND user_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_log_company_created
  ON audit_log(company_id, created_at DESC, id DESC)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_company_user_created
  ON audit_log(company_id, user_id, created_at DESC)
  WHERE company_id IS NOT NULL;

-- Inviti: il token in chiaro viene mostrato solo nel link al destinatario.
-- Nel database viene conservato esclusivamente il digest SHA-256 esadecimale.
CREATE TABLE IF NOT EXISTS company_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  email VARCHAR(254) NOT NULL,
  role VARCHAR(24) NOT NULL
    CHECK (role IN ('admin', 'manager', 'operator', 'warehouse', 'accounting')),
  token_hash CHAR(64) NOT NULL UNIQUE
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by_membership_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (email = lower(btrim(email))),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status <> 'pending' OR expires_at > created_at),
  FOREIGN KEY (invited_by_membership_id, company_id)
    REFERENCES company_memberships(id, company_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_company_invitations_company_status
  ON company_invitations(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_company_invitations_expiry
  ON company_invitations(expires_at)
  WHERE status = 'pending';

-- Impedisce duplicati pendenti per la stessa email normalizzata nella stessa azienda.
-- Un invito scaduto deve essere portato a status='expired' prima di un nuovo invito.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_invitations_pending_email
  ON company_invitations(company_id, email)
  WHERE status = 'pending';

COMMIT;

-- BLOCCO / DIPENDENZE:
-- 1. Questa migrazione presuppone che 005 abbia creato companies e company_memberships.
-- 2. Prima di applicarla, verificare che tutte le righe audit storiche possano restare
--    senza company_id e che nessun codice si aspetti company_id NOT NULL.
-- 3. L'applicazione deve scrivere membership_id/company_id/user_id coerenti.
-- 4. La tabella inviti non implementa consegna email, verifica del destinatario,
--    registrazione identità o accettazione: tali flussi richiedono provider e codice.
-- 5. Non è implementato qui un trigger append-only: va deciso e testato con il ruolo DB.
-- 6. Nessuna migrazione 005/006/007 va aggiunta a migrate.js finché il clone PostgreSQL,
--    il backfill e i test d'integrazione non sono approvati.
