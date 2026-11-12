-- FUNERAL SMART — bozza migrazione 006: contesto aziendale per sessione
-- DIPENDE dalla bozza 005_multi_tenant_foundation.draft.sql.
-- NON ESEGUIRE: non è registrata in migrate.js e non è pronta per produzione.
-- Scopo: memorizzare la membership attiva nella singola sessione, non nell'utente globale.
--
-- La FK composta (user_id, active_membership_id) impedisce di associare alla sessione
-- di un utente la membership appartenente a un altro utente.
-- Il middleware dovrà comunque verificare status='active' e companies.status='active'
-- ad ogni richiesta: la FK da sola non rileva sospensioni/revoche logiche.

BEGIN;

-- Necessario come target della FK composta, pur essendo id già PK.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_memberships_user_id_id
  ON company_memberships(user_id, id);

ALTER TABLE app_sessions
  ADD COLUMN IF NOT EXISTS active_membership_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_app_sessions_active_membership_user'
      AND conrelid = 'public.app_sessions'::regclass
  ) THEN
    ALTER TABLE app_sessions
      ADD CONSTRAINT fk_app_sessions_active_membership_user
      FOREIGN KEY (user_id, active_membership_id)
      REFERENCES company_memberships(user_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_app_sessions_active_membership
  ON app_sessions(active_membership_id)
  WHERE active_membership_id IS NOT NULL;

COMMIT;

-- ROLLOUT:
-- 1. Applicare solo su un clone ripristinato da backup dopo aver collaudato la 005.
-- 2. Creare l'azienda iniziale e le membership per gli account esistenti.
-- 3. Associare le sessioni esistenti alla membership iniziale in modo esplicito;
--    non assumere che il ruolo globale app_users.role sia un ruolo aziendale definitivo.
-- 4. Implementare endpoint di selezione azienda che aggiorna la sessione corrente
--    solo dopo aver verificato membership.user_id=req.user.id e status='active'.
-- 5. Nel middleware, join app_sessions -> company_memberships -> companies e
--    verificare contemporaneamente sessione valida, utente attivo, membership attiva,
--    azienda attiva; costruire req.tenant dai dati DB.
-- 6. Non usare il company_id inviato dal client come autorizzazione.
-- 7. Testare revoca membership con sessione già aperta: la richiesta successiva deve
--    essere respinta immediatamente anche se il cookie non è scaduto.
-- 8. Non eliminare la colonna app_users.role finché non è completata la migrazione
--    dei permessi e verificata la compatibilità del client; non usarla per autorizzare
--    le richieste tenant-aware.
