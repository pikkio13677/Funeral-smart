# Platform owner — piano di gestione centrale delle aziende

Stato: PROGETTAZIONE / DRAFT. Nessuna rotta montata, nessuna migrazione eseguita, nessun accesso ai dati di produzione.

## 1. Distinzione fondamentale del dominio

Nel database FUNERAL SMART esistono due concetti diversi:

- **companies**: aziende clienti del servizio gestionale SaaS. Sono introdotte dalla bozza multi-tenant 005 e collegate a utenti tramite `company_memberships`. Il proprietario della piattaforma deve amministrare queste aziende.
- **providers**: imprese funebri presenti nell'elenco pubblico del marketplace. Sono già presenti in `schema.sql`, con servizi, listini e stato di verifica. Non sono automaticamente account clienti SaaS.

Anche `provider_applications` rappresenta candidature al marketplace, non richieste di attivazione di un tenant SaaS. Non collegare automaticamente provider, candidature e companies tramite partita IVA o nome: un collegamento richiede una decisione di prodotto esplicita e una relazione verificata.

## 2. Perimetro della prima versione

La prima area centrale deve consentire al solo ruolo piattaforma autorizzato di:

1. elencare le aziende SaaS con ricerca e paginazione;
2. consultare una scheda azienda con dati anagrafici essenziali, stato, piano dichiarato, date e conteggi aggregati;
3. attivare o sospendere un'azienda, con motivazione obbligatoria;
4. modificare il codice piano solo quando la matrice piani sarà definita;
5. consultare l'elenco degli amministratori/membri senza leggere i dati delle pratiche funerarie;
6. consultare gli eventi di audit di piattaforma e le azioni amministrative sulle aziende.

Fuori perimetro: cancellazione fisica delle aziende, modifica dei dati delle famiglie/dei defunti, accesso ordinario a pratiche o fatture delle aziende, impersonificazione, accesso di supporto non motivato, incassi o fatturazione SaaS automatica.

## 3. Autorizzazione e isolamento

- Le nuove rotte vivono sotto `/api/v1/platform` e usano autenticazione nominativa + MFA + `requirePlatformRole('owner')`.
- Non usare `auth.authorize` come autorizzazione piattaforma e non considerare `app_users.role='admin'` prova di accesso centrale.
- Il middleware `platform-access.js` deve verificare a database, a ogni richiesta, che l'utente sia attivo e abbia `platform_access.role='owner'` e `status='active'`.
- Le rotte piattaforma non devono montarsi sotto `/api/v1/admin` e non devono ereditare il router gestionale aziendale.
- Tutte le query devono usare parametri SQL. Gli identificativi ricevuti dal client individuano la risorsa, ma non concedono privilegi.
- Le risposte elenco/dettaglio devono limitarsi ai campi amministrativi necessari; niente note delle pratiche, recapiti delle famiglie, dati dei defunti, documenti, pagamenti o contenuti dei tenant.
- Nessun accesso cross-tenant ai dati operativi nella prima versione.

## 4. Contratto API proposto

- `GET /api/v1/platform/companies?status=&q=&cursor=&limit=`: elenco paginato; allowlist dei filtri; limite massimo 100.
- `GET /api/v1/platform/companies/:companyId`: scheda anagrafica e aggregati minimizzati.
- `PATCH /api/v1/platform/companies/:companyId/status`: transizioni consentite e motivazione obbligatoria; ogni transizione deve essere auditata.
- `GET /api/v1/platform/companies/:companyId/members`: username/display name, ruolo membership, stato e date strettamente necessari; nessun hash password, email non verificata o segreto MFA.
- `GET /api/v1/platform/audit`: registro centrale con paginazione cursor-based e filtri allowlist.

Non introdurre endpoint generici di modifica, query SQL dinamiche, cancellazioni o impersonificazione.

## 5. Stato azienda e transizioni

La bozza 005 definisce `companies.status` come `active`, `suspended` o `closed`.

- `active -> suspended`: consentito all'owner, motivazione obbligatoria; l'accesso tenant deve essere rifiutato immediatamente alle richieste successive.
- `suspended -> active`: consentito all'owner, motivazione obbligatoria e audit.
- `active/suspended -> closed`: non implementare nella prima versione; richiede policy di conservazione, esportazione, fatturazione e cancellazione.
- Vietato cancellare fisicamente una company dalla console centrale.
- Ogni azione deve essere atomica con il relativo audit; se l'audit fallisce, la modifica deve fare rollback.

La sola modifica del campo `companies.status` non è sufficiente: prima del rollout il middleware tenant deve controllare lo stato dell'azienda a ogni richiesta, anche quando la sessione utente è ancora valida.

## 6. Audit e protezione dei dati

Ogni azione centrale deve registrare almeno attore, azione, risorsa, ID risorsa, timestamp, motivazione normalizzata e risultato. Il log non deve contenere password, token, cookie, segreti MFA, codici di recupero o payload completi.

Gli eventi di piattaforma devono essere distinti dall'audit aziendale. L'owner può leggere i metadati amministrativi della piattaforma, non il contenuto delle pratiche dei clienti. Eventuali accessi assistiti ai dati di un tenant richiedono un progetto separato con:
- richiesta motivata e approvazione esplicita;
- ambito e durata limitati;
- identità dell'operatore e tenant coinvolto;
- banner/indicazione visibile all'azienda, ove applicabile;
- audit di inizio/fine e delle operazioni;
- revoca automatica alla scadenza.

La prima versione non implementa accesso assistito.

## 7. Piani e fatturazione

La colonna `companies.plan_code` nella bozza 005 è solo un codice piano, non prova che un abbonamento sia pagato o attivo. Non mostrare "pagato", "scaduto" o "in regola" basandosi su quel campo.

Prima di gestire pagamenti SaaS servono modello abbonamenti, prezzi/versioni piano, periodi, stato, provider pagamenti, webhook firmati, idempotenza, fatture e riconciliazione. Questa parte resta fuori da questa PR.

## 8. Test obbligatori prima di montare le rotte

- admin aziendale, support e utente non autenticato ricevono 401/403;
- owner sospeso/inattivo viene respinto anche con sessione esistente;
- owner attivo può consultare solo i campi amministrativi consentiti;
- UUID azienda inesistente restituisce 404 senza rivelare dati;
- filtri/paginazione non permettono SQL injection o enumerazione non autorizzata;
- sospensione blocca immediatamente il tenant middleware;
- ogni modifica di stato e il relativo audit sono atomici;
- errore audit provoca rollback;
- nessuna risposta contiene dati di pratiche, defunti, famiglie, credenziali o MFA;
- provider marketplace e candidature non vengono scambiati per companies SaaS.

## 9. Dipendenze e blocchi

Dipendenze: migrazioni tenant 005/006/008, platform access 009, bootstrap 010, audit tenant 007 e middleware tenant verificato. Queste migrazioni restano draft e non sono registrate in `migrate.js`.

Prima di implementare le rotte occorre completare la review dello schema e dei middleware, quindi testare su PostgreSQL disposable. Non montare router, non abilitare `ENABLE_MULTI_TENANT`, non applicare migrazioni persistenti e non modificare Render.

## 10. Divieti operativi

Questa progettazione non autorizza merge, deploy, migrazioni su produzione, creazione dell'account owner, modifiche Render, invio email reali o accesso ai dati delle aziende clienti.
