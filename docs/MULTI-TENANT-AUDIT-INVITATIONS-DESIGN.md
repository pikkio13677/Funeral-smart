# FUNERAL SMART — Progettazione registro attività e inviti aziendali

Stato: DESIGN ONLY — nessuna migrazione o rotta attivata.
Branch: `feat/multi-azienda-foundation`.

## 1. Evidenze dello schema attuale

Verifiche sul branch:
- `users.sql` crea `audit_log` con `user_id`, `username`, `action`, `resource`, `resource_id`, `ip_address`, `created_at`.
- `audit_log` non contiene `company_id`; gli indici attuali sono globali per data e utente.
- `auth.js` scrive nel registro tramite una funzione `audit()` che non riceve né salva il contesto aziendale.
- `app_users` contiene username, display_name e credenziali, ma non un indirizzo email.
- La bozza `005_multi_tenant_foundation.draft.sql` aggiunge `company_id` alle nove tabelle gestionali, ma non a `audit_log`.
- Non è presente una configurazione verificata di un provider email/transazionale nel codice esaminato.
- Le migrazioni 005 e 006 sono bozze non registrate in `migrate.js` e non devono essere eseguite in produzione.

Queste evidenze impediscono di implementare inviti email realmente consegnabili e un audit log aziendale affidabile senza prima completare le dipendenze.

## 2. Registro attività aziendale — modello proposto

### Dati

Aggiungere a `audit_log`:
- `company_id UUID NULL REFERENCES companies(id) ON DELETE RESTRICT`
- `membership_id UUID NULL REFERENCES company_memberships(id) ON DELETE RESTRICT`
- eventualmente `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`, con allowlist dei campi ammessi e senza password, token, segreti MFA, codici di recupero o dati di pagamento.

Conservare `user_id` nullable per mantenere la storia anche quando un account viene disattivato/eliminato secondo le regole esistenti. Gli eventi di piattaforma/autenticazione senza contesto aziendale possono restare con `company_id IS NULL`; non devono comparire nel registro visibile all'azienda.

Indici proposti:
- `(company_id, created_at DESC, id DESC)`
- `(company_id, user_id, created_at DESC)`
- indice parziale per `company_id IS NOT NULL`, se utile dopo aver misurato i volumi.

### Scrittura

- Introdurre un servizio audit condiviso che accetti esplicitamente il contesto tenant verificato dal server, l'attore, l'azione, la risorsa e i metadati consentiti.
- Per eventi aziendali, `company_id` e `membership_id` devono provenire esclusivamente da `req.tenant`, mai dal body/query/header del client.
- Scrivere l'evento nella stessa transazione dell'operazione aziendale quando l'evento descrive una modifica dati; se l'insert audit fallisce, l'operazione deve fare rollback.
- Per eventi di autenticazione globali mantenere il contesto nullo finché non esiste una membership verificata.
- Non registrare contenuti sensibili o interi payload delle richieste.

### Lettura e immutabilità

- Endpoint tenant dedicato, ad esempio `GET /api/v1/company/activity`, con middleware autenticazione + tenant-context + permesso esplicito.
- Query sempre filtrata da `company_id = req.tenant.companyId`; paginazione cursor-based su coppia `created_at,id`, limite massimo per pagina e filtri allowlist.
- Non esporre IP o metadati tecnici agli utenti ordinari, salvo necessità amministrativa documentata.
- Nessuna rotta applicativa UPDATE/DELETE per gli eventi. Valutare trigger PostgreSQL che rifiuti UPDATE/DELETE e una retention formalizzata; un ruolo DB con privilegi limitati è preferibile alla sola convenzione applicativa.
- Gli amministratori aziendali possono leggere solo la propria azienda; un ruolo piattaforma, se introdotto, deve avere percorso separato e accesso motivato/auditato.

## 3. Inviti utenti — modello proposto

### Tabella

Tabella `company_invitations` separata da `app_users` e membership:
- `id UUID PRIMARY KEY`
- `company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT`
- `email VARCHAR(254) NOT NULL` normalizzata (trim + lowercase)
- `role VARCHAR(24) NOT NULL` con allowlist dei ruoli aziendali; mai consentire invito come platform admin
- `token_hash CHAR(64) NOT NULL UNIQUE` (mai salvare il token in chiaro)
- `invited_by_membership_id UUID NOT NULL REFERENCES company_memberships(id)`
- `status` con stati controllati: pending, accepted, revoked, expired
- `expires_at TIMESTAMPTZ NOT NULL`, `accepted_at`, `revoked_at`, `created_at`
- vincolo/indice parziale per impedire più inviti pending alla stessa email nella stessa azienda, dopo aver definito la policy per reinviti.

Il token deve essere generato con CSPRNG, mostrato solo nel link di invito, memorizzato solo come SHA-256, confrontato in modo sicuro e invalidato atomicamente all'accettazione/revoca/scadenza. Durata iniziale suggerita: 72 ore, configurabile.

### Flusso

1. Company admin autenticato richiede invito. Il server verifica membership attiva, azienda attiva, ruolo consentito e limiti del piano.
2. Il server crea l'invito in transazione e registra l'evento audit aziendale.
3. Un provider email configurato invia un link HTTPS con token monouso. Se l'invio fallisce, l'invito resta non consegnato e deve essere marcato/gestito esplicitamente; non dichiarare l'invio riuscito.
4. L'utente apre il link e completa la verifica del possesso dell'indirizzo email.
5. Se esiste già un'identità globale verificata per quell'email, collegare la membership solo dopo prova di possesso. Poiché lo schema attuale non memorizza email su `app_users`, serve decidere se aggiungere email verificata all'identità globale o gestire un flusso di associazione separato.
6. Se l'identità non esiste, completare una registrazione globale con username/password e verifica email; poi creare la membership.
7. Accettazione, creazione membership e marcatura invito accepted devono avvenire in un'unica transazione con lock della riga invito.
8. Un invito non deve creare automaticamente un account attivo senza verifica email; non deve poter essere accettato da un utente diverso dal destinatario.
9. Revoca membership e invito devono essere immediatamente rispettate dal middleware tenant alle richieste successive.

### Email provider

Prima di implementare la consegna occorre scegliere e configurare un provider (es. servizio SMTP/API transazionale), verificare dominio mittente, credenziali come secret Render, URL pubblico HTTPS e gestione errori. Non mettere credenziali o token nei log. Non assumere che il provider sia già configurato.

## 4. Sequenza sicura di implementazione

1. Verificare lo schema effettivo di MFA/sessioni e il comportamento attuale di `auth.js` sul branch.
2. Aggiornare la bozza di schema per audit tenant e inviti, senza registrarla in `migrate.js`.
3. Definire come verificare e memorizzare le email delle identità globali.
4. Scegliere il provider email e definire invio, retry, idempotenza e gestione dei fallimenti.
5. Implementare servizi e router isolati, non montati in `server.js`.
6. Aggiungere test unitari per autorizzazione, token, scadenza, replay, revoca, cross-tenant e rollback.
7. Preparare test d'integrazione PostgreSQL su database clone, incluse concorrenza e vincoli.
8. Solo dopo restore-test, revisione e approvazione esplicita valutare migrazioni e rollout.

## 5. Test di accettazione obbligatori

### Audit
- Azienda A non può leggere eventi di B cambiando filtri o UUID.
- Evento aziendale non può essere scritto senza tenant verificato.
- Una modifica aziendale e il relativo evento audit sono atomici.
- UPDATE/DELETE degli eventi sono respinti.
- Nessun segreto o dato di autenticazione compare in action/metadata.

### Inviti
- Token non compare in chiaro nel database o nei log.
- Token scaduto, revocato o già usato non può essere riutilizzato.
- Invito A non crea membership in B.
- Il destinatario deve dimostrare il possesso dell'email.
- Ruoli non consentiti e auto-promozioni a platform admin sono respinti.
- Due accettazioni concorrenti producono una sola membership.
- Fallimento email non viene presentato come invito consegnato.

## 6. Blocco di sicurezza

Questo documento non autorizza:
- aggiunta delle migrazioni 005/006 a `migrate.js`;
- applicazione di SQL su Render o sul database reale;
- modifica delle rotte operative o del login attuale;
- montaggio dei nuovi router in `server.js`;
- invio di email o creazione di account reali;
- merge della PR o deploy.

Tutto resta isolato nel branch di sviluppo fino a test su clone e approvazione esplicita.


## 7. Bozza schema predisposta

È stata aggiunta `migrations/007_audit_invitations.draft.sql` come bozza non eseguita, dipendente dalla 005. Introduce i campi tenant per audit e la tabella inviti con token hashato, scadenza, stato e vincoli membership/azienda. Non implementa invio email, verifica destinatario, accettazione applicativa o trigger append-only. Rimane fuori da `migrate.js`.


## 8. Avanzamento implementazione isolata

- Aggiunto `tenant-audit-routes.js`: endpoint GET `/company/activity`, sola lettura, accesso subordinato a contesto tenant verificato e permesso `audit:read`.
- La query filtra sempre per `req.tenant.companyId`, usa paginazione cursor-based su `created_at,id`, limite massimo 100 e non restituisce l'indirizzo IP.
- Aggiunti test mock in `test/tenant-audit-routes.test.js` e controllo sintattico nel comando `npm run check`.
- Il router resta isolato e NON è montato in `server.js`; dipende dalla futura attivazione delle migrazioni 005/006/007.
- Corretta la bozza 007: la FK dell'invitante ora dispone dell'indice univoco richiesto su `company_memberships(id, company_id)`; il contesto tenant dell'audit ha un CHECK dedicato separato dalla FK. È stata aggiunta anche una coerenza minima tra stato pending e scadenza.
- La migrazione resta una bozza non eseguita e non è stata validata su un server PostgreSQL reale. I test mock non provano sintassi SQL, vincoli, concorrenza o isolamento database.
- Gli inviti NON sono ancora implementati come flusso operativo: manca una email verificata associata a `app_users`, un provider email configurato e il flusso sicuro di accettazione. Non viene creato alcun invito né dichiarata alcuna consegna.
