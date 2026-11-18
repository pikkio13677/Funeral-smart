-- FUNERAL SMART — bozza migrazione 014: anonimizzazione delle richieste
-- STAGED / NON ESEGUITA. Dipende dallo schema base e dalla finalizzazione tenant.
-- NON registrare in migrate.js e NON applicare a produzione senza approvazione.
--
-- Le richieste eliminate logicamente devono poter conservare la sola traccia
-- amministrativa minima senza mantenere recapiti, note o dettagli identificativi.
-- I record storici già marcati deleted non vengono modificati automaticamente.

DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  FOR old_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.inquiries'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%contact_email IS NOT NULL%'
      AND pg_get_constraintdef(oid) LIKE '%contact_phone IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE public.inquiries DROP CONSTRAINT %I', old_constraint);
  END LOOP;
END $$;

ALTER TABLE public.inquiries
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_inquiries_contact_required_unless_deleted'
      AND conrelid = 'public.inquiries'::regclass
  ) THEN
    ALTER TABLE public.inquiries
      ADD CONSTRAINT ck_inquiries_contact_required_unless_deleted
      CHECK (
        status = 'deleted'
        OR contact_email IS NOT NULL
        OR contact_phone IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_inquiries_anonymized_requires_deleted'
      AND conrelid = 'public.inquiries'::regclass
  ) THEN
    ALTER TABLE public.inquiries
      ADD CONSTRAINT ck_inquiries_anonymized_requires_deleted
      CHECK (anonymized_at IS NULL OR status = 'deleted');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inquiries_anonymized_at
  ON public.inquiries(anonymized_at)
  WHERE anonymized_at IS NOT NULL;

-- L'endpoint applicativo deve impostare status='deleted', anonymized_at=NOW(),
-- cancellare email, telefono, note, budget e destinazione e sostituire comune
-- e servizio con valori neutri. Nessun record viene cancellato fisicamente.
