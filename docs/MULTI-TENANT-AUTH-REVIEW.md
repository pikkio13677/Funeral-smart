# FUNERAL SMART — revisione autenticazione prima del codice multi-tenant

## Esito della lettura del codice attuale

File verificati nel branch:
- `auth.js`
- `server.js`
- `users.sql`
- `mfa.sql`
- `migrate.js`
- `admin-routes.js`
- `gestionale.sql`

Il login attuale crea una sessione legata a `app_users.id`; la sessione non contiene ancora un'azienda attiva. L'autorizzazione legge `app_users.role`, che è un ruolo globale. Le rotte `/auth/users` elencano e creano account globali. Le rotte gestionali usano `req.user` e query senza filtro aziendale.

## Modifiche richieste in una futura PR applicativa

### 1. Autenticazione
- Conservare il login username/password e la verifica MFA già funzionanti.
- Conservare token casuale, hash SHA-256 nel database e cookie HttpOnly.
- Includere la membership attiva nella lettura della sessione, con join e controlli su membership e azienda attive.
- Non inserire il ruolo aziendale nel cookie né fidarsi di dati del client.
- Quando una membership viene revocata o l'azienda sospesa, negare la richiesta successiva senza attendere la scadenza del cookie.

### 2. MFA e sessioni
- La MFA resta legata all'identità globale: non va duplicata per ogni azienda.
- Il completamento MFA crea una sessione autenticata ma senza accesso ai reparti finché non viene selezionata una membership attiva.
- Il cambio azienda modifica solo il contesto della sessione corrente.
- Logout continua a revocare la sessione corrente.
- Un cambio di password, disattivazione account o procedura di sicurezza deve poter revocare tutte le sessioni dell'identità.

### 3. Bootstrap
- Il bootstrap iniziale deve creare identità e, nella stessa transazione, l'azienda iniziale e la membership admin iniziale quando la migrazione è pronta.
- Il token bootstrap resta monouso e non deve poter creare altre aziende dopo l'inizializzazione.
- Prima di cambiare bootstrap, progettare una procedura di migrazione per l'account amministratore già esistente.

### 4. Gestione utenti
- Sostituire la creazione globale `POST /auth/users` con inviti nella sola azienda attiva.
- L'identità globale può essere membro di più aziende, ma ogni azienda assegna il proprio ruolo.
- Non esporre elenco globale degli utenti agli amministratori aziendali.
- L'amministratore di un'azienda non può promuovere un utente a platform-admin.
- Proteggere l'ultimo amministratore attivo: non può essere rimosso o declassato senza un trasferimento atomico del ruolo.

### 5. Separazione piattaforma/tenant
- `platform_admin` deve essere un privilegio separato, conservato in una struttura di autorizzazione di piattaforma e con accesso auditato.
- Il ruolo `admin` nelle membership significa solo amministratore della singola azienda.
- La vecchia autorizzazione basata su `req.user.role === 'admin'` non deve essere riutilizzata sulle rotte tenant.
- Le rotte marketplace pubbliche e di amministrazione piattaforma vanno mantenute fuori dal tenant context, con autorizzazioni distinte.

## Decisioni di sicurezza
- Nessun accesso tenant-aware senza membership attiva selezionata.
- Nessun fallback a `ADMIN_API_KEY` sulle rotte gestionali tenant.
- Non convertire automaticamente `app_users.role` in privilegi di piattaforma.
- Non cancellare né alterare sessioni/MFA esistenti durante la migrazione senza un piano e test di regressione.
- Audit log aziendale deve includere `company_id`; eventi globali di autenticazione restano distinguibili dagli eventi aziendali.

## Gate prima della PR applicativa
1. Migrazione 005 collaudata su clone e backfill approvato.
2. Migrazione 006 collaudata su clone.
3. Decisione documentata su quale account esistente diventa admin della prima azienda.
4. Test MFA, login, logout e revoca membership.
5. Test cross-tenant con due aziende.
6. Revisione di tutte le query di `admin-routes.js`, non soltanto del middleware.
