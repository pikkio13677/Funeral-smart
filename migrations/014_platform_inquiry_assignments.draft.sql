-- FUNERAL SMART — bozza migrazione 014: assegnazione controllata delle richieste alle imprese
-- STAGED / NON ESEGUITA. Dipende dallo schema marketplace e dalla migrazione audit 012.
-- NON aggiungere a migrate.js e NON eseguire su Render/produzione senza approvazione.
-- Le assegnazioni sono risorse della piattaforma: non appartengono al tenant gestionale
-- di una singola impresa. L'API consente di assegnare solo imprese verificate.

CREATE TABLE IF NOT EXISTS inquiry_provider_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id UUID NOT NULL REFERENCES inquiries(id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  assigned_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  revocation_reason VARCHAR(500),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
);

-- Una sola impresa può avere l'incarico attivo per ogni richiesta.
-- Le assegnazioni revocate restano nello storico e non vengono sovrascritte.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inquiry_provider_assignments_one_active
  ON inquiry_provider_assignments(inquiry_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_inquiry_provider_assignments_history
  ON inquiry_provider_assignments(inquiry_id, assigned_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_inquiry_provider_assignments_provider
  ON inquiry_provider_assignments(provider_id, status, assigned_at DESC);

COMMENT ON TABLE inquiry_provider_assignments IS
  'Assegnazioni di richieste pubbliche gestite dalla piattaforma; non sono dati gestionali tenant.';
