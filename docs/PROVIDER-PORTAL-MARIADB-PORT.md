# Area Imprese — porting plan PostgreSQL → MariaDB

Status: analisi tecnica iniziale, nessuna migrazione eseguita e nessun database modificato.

## Obiettivo
Mantenere il contratto HTTP e le schermate dell'Area Imprese, sostituendo il livello PostgreSQL con MariaDB in un ambiente di test isolato. Il portale non deve essere abilitato finché schema, autenticazione e test d'integrazione non sono pronti.

## Stato verificato nel codice
- `provider-portal.html` è una dashboard operativa: profilo, statistiche, elenco e dettaglio richieste, accetta/rifiuta con motivazione, inviti, collaboratori, ruoli, registro attività e statistiche aziendali.
- `provider-portal-preview.html` è una demo statica, non la dashboard collegata alle API.
- Le API sono in `provider-portal-routes.js` e `provider-portal-invitation-routes.js`.
- Il mount API in `api-route-mounts.js` richiede esplicitamente `ENABLE_PROVIDER_PORTAL=true` e verifica l'esistenza di sette tabelle.
- La migrazione `migrations/015_provider_portal_access.draft.sql` è marcata come bozza non eseguita e dipende dalle tabelle marketplace e assegnazioni precedenti.
- `migrate.js` usa `pg`, `DATABASE_URL` e sintassi PostgreSQL. Il backend attuale richiede Node >=20.
- Il codice di inviti e risposte usa transazioni, query parametrizzate e controlli di autorizzazione per impresa. Queste proprietà vanno preservate.

## Endpoint Area Imprese individuati
- `GET /api/v1/provider-portal/me`
- `GET /api/v1/provider-portal/dashboard`
- `GET /api/v1/provider-portal/inquiries`
- `GET /api/v1/provider-portal/inquiries/:assignmentId`
- `POST /api/v1/provider-portal/inquiries/:assignmentId/response`
- `GET /api/v1/provider-portal/dashboard/analytics`
- `GET /api/v1/provider-portal/activity`
- Inviti: creazione, elenco, revoca e accettazione
- Collaboratori: elenco, sospensione/riattivazione e modifica ruolo

## Stato del porting nel branch di lavoro

Branch isolato aggiornato: `work/provider-area-mariadb-current` (basato sull'attuale `main`). Nessuna modifica a `main`, nessun deploy e nessuna migrazione eseguita.

- Implementati adapter MariaDB, middleware provider, endpoint `/me`, dashboard e richieste.
- Implementate route MariaDB per inviti, accettazione con email verificata, revoca, membri, sospensione/riattivazione e cambio ruolo.
- Implementati endpoint MariaDB per statistiche mensili, andamento a sei mesi e registro attività.
- Aggiunti test unitari con adapter finti e controlli sintattici per i moduli portati.
- I test non sono ancora stati eseguiti su MariaDB reale; i test con adapter finti non provano schema, tipi, vincoli o comportamento del motore.

## Dipendenze schema verificate nel repository

È stata completata anche la ricognizione dei file SQL sorgente (non del database live):

- `schema.sql` definisce `providers`, `service_types`, `provider_services`, `price_lists`, `provider_applications` e `inquiries`. Le colonne lette dalle route richieste risultano presenti.
- `users.sql` definisce `app_users` con `id`, `username`, `display_name`, `role` e `active`.
- La bozza `migrations/007_audit_invitations.draft.sql` aggiunge `app_users.email` e `email_verified_at`; senza l'equivalente MariaDB l'accettazione invito deve restare disabilitata.
- La bozza `migrations/014_platform_inquiry_assignments.draft.sql` definisce `inquiry_provider_assignments` con `inquiry_id`, `provider_id`, `assigned_at` e `status`.
- La bozza `migrations/015_provider_portal_access.draft.sql` definisce accessi, inviti, risposte e audit usati dalle nuove route.

Questi file sono PostgreSQL e le migrazioni 007, 014 e 015 sono bozze non eseguite. La verifica del sorgente conferma i nomi delle colonne attese, ma non prova che tali tabelle esistano già nel MariaDB installato né stabilisce i tipi MariaDB da usare. La migrazione MariaDB deve tradurre anche vincoli, indici parziali e chiavi composte; non basta copiare il DDL PostgreSQL.

## Schema MariaDB preparato

È stato aggiunto `mariadb/schema-provider-portal.sql` nel branch di lavoro.

- Schema base marketplace coerente con `schema.sql`: utenti/sessioni, imprese, servizi, listini, candidature e richieste.
- Tabelle portale: assegnazioni, accessi, inviti, risposte e audit.
- UUID rappresentati come `CHAR(36)` ASCII binario; date come `DATETIME(3)` UTC; importi come `DECIMAL`.
- Un solo incarico attivo per richiesta e un solo invito pendente per impresa/email sono protetti con colonne generate e indici univoci, in sostituzione degli indici parziali PostgreSQL.
- Relazioni risposta/audit verso assegnazione e impresa protette da FK composte.
- Email verificata univoca tramite colonna generata; nessun collegamento automatico degli account per email.
- Seed dei tipi servizio ripetibile.

Il file è un DDL autonomo per un database MariaDB di staging vuoto. Non è stato eseguito, non è incluso in `migrate.js`, non crea account amministrativi e non invia email. Prima dell'uso vanno verificati supporto effettivo delle CHECK su MariaDB 10.11, permessi, collation, modalità SQL e coerenza del driver. L'esecuzione dovrà essere esplicita e solo su database temporaneo dedicato.

## Verifiche ancora obbligatorie prima dell'integrazione

1. Confrontare ogni tabella/colonna usata dalle route con le migrazioni marketplace effettive e con lo schema del MariaDB di staging.
2. Definire una migrazione MariaDB separata per accessi, inviti, risposte e audit, con chiavi UUID coerenti, indici, vincoli univoci e FK tenant-safe.
3. Verificare compatibilità con il runtime: il progetto dichiara Node >=20, mentre il server era stato rilevato con Node 18.19.1.
4. Eseguire `npm ci`, `npm run check` e `npm test` in un ambiente isolato; poi test d'integrazione su database temporaneo MariaDB.
5. Verificare il contratto frontend e montare le route soltanto su staging dopo approvazione esplicita. Non abilitare il portale sul backend PostgreSQL attuale.

## Incompatibilità PostgreSQL da risolvere
1. Placeholder `$1` → placeholder `?` del driver MariaDB, con adeguata gestione dell'ordine dei parametri.
2. `RETURNING` → `insertId` e successiva SELECT nella stessa transazione quando occorre restituire la riga inserita.
3. `UUID` / `gen_random_uuid()` → strategia coerente `CHAR(36)` o `BINARY(16)`; generazione UUID in Node, dopo aver verificato il tipo delle chiavi nelle tabelle preesistenti.
4. `TIMESTAMPTZ` → `DATETIME(3)` con convenzione UTC esplicita.
5. `FILTER (WHERE ...)` → `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`.
6. `date_trunc`, intervalli PostgreSQL, `EXTRACT(EPOCH...)`, cast `::int`/ `::numeric` → funzioni MariaDB equivalenti (`DATE_FORMAT`, `DATE_SUB`, `TIMESTAMPDIFF`, `CAST`).
7. `FOR UPDATE` resta disponibile su tabelle InnoDB, ma va verificato che ogni percorso transazionale usi la stessa connessione e che le tabelle siano InnoDB.
8. `to_regclass` nel controllo di disponibilità dello schema → verifica su `information_schema.tables`.

## Sequenza di implementazione sicura
1. Confrontare `mariadb/schema-provider-portal.sql` con il server MariaDB 10.11 di staging (tipi, generated columns, CHECK, default UTC, FK e indici) senza eseguire ancora il file.
2. Eseguire la prima prova DDL solo su un database temporaneo vuoto, dopo autorizzazione esplicita; verificare creazione, seed ripetibile e rollback/ricreazione.
3. Generare e committare un `package-lock.json` coerente con Node 20, poi far passare la CI isolata (`npm run check`, `npm test`).
4. Eseguire test d'integrazione con MariaDB reale usa-e-getta per accesso, isolamento provider, invito con token hash, accettazione/rifiuto, ultimo amministratore, statistiche e audit.
5. Correggere eventuali differenze fra schema reale, query e frontend; montare i router MariaDB in un server staging separato, non nel server PostgreSQL corrente.
6. Solo dopo test verdi, predisporre variabili ambiente e Node >=20 sul server di staging. Email disabilitate o intercettate.
7. Abilitare il portale esclusivamente in staging e collaudare da smartphone.

## Esito CI isolata

Il workflow `.github/workflows/provider-mariadb-ci.yml` è stato eseguito su GitHub Actions con Node 20.20.2. Nell'ultimo run verificato sul branch (commit `2380fd7475589da2ba5c7c6a844640568b381a56`):
- `npm install`: superato.
- `npm run check`: superato.
- `npm test`: superato, 279 test totali, 279 passati.
- Il workflow non esegue deploy e non si collega a database; usa solo test automatizzati con adapter finti e controlli statici sul DDL.

Questo esito non equivale ancora a un test end-to-end del portale.

### Test reale dello schema su MariaDB 10.11 (CI temporanea)

È stato aggiunto un servizio MariaDB 10.11 effimero al workflow GitHub Actions. Il job applica due volte lo schema completo in un database CI usa-e-getta e verifica:
- creazione delle tabelle marketplace e Area Imprese;
- seed ripetibile dei tipi servizio, incluso `cremation-burial`;
- collegamento reale `providers → provider_services → service_types`;
- collegamento di un listino alla stessa tipologia tramite le foreign key.

Il primo test ha evidenziato incompatibilità MariaDB nei CHECK e nelle colonne generate che dipendevano da colonne FK. Lo schema è stato corretto: le chiavi nullable per unicità degli incarichi attivi e degli inviti pendenti sono ora colonne gestite dall'applicazione. Le route inviti popolano e svuotano i campi pendenti nelle transizioni di stato. Il job MariaDB 10.11 è poi passato.

Limite ancora da rispettare: la creazione/riassegnazione degli incarichi attivi deve valorizzare `active_inquiry_id` a `inquiry_id` e azzerarlo quando l'incarico viene revocato; il relativo flusso di assegnazione MariaDB va verificato/implementato prima di abilitarlo. Il test CI convalida DDL e relazioni di provider/listino, non un end-to-end completo del portale.

## Blocco attuale
È stato preparato uno schema MariaDB completo di staging, ma non è stato ancora validato dal motore MariaDB effettivo e non è stato eseguito. La CI GitHub è stata trasferita sul branch aggiornato; il risultato del nuovo run deve ancora essere verificato. Il server rilevato in precedenza usa Node 18.19.1, mentre il progetto richiede Node >=20. Prima del collegamento delle API servono test reali MariaDB, verifica del runtime e confronto finale con il frontend.

## Vincoli
- Nessuna modifica al database PostgreSQL esistente.
- Nessuna esecuzione di migrazioni su produzione.
- Nessuna attivazione di `ENABLE_PROVIDER_PORTAL` finché il porting e i test non sono completati.
- Nessuna email reale durante i test.
- Conservare la demo e le pagine attuali; non sostituirle con una nuova interfaccia prima del collaudo API.


## Router composition

The MariaDB Area Imprese router factory is `provider-portal-mariadb/index.js`.
It mounts the invitation router before the provider-membership router under the same
API prefix. This ordering is intentional: platform administrators must be able to
create the first provider invitation, and an already authenticated user must be
able to accept an invitation before they have provider membership. The regular
portal endpoints still require the provider context.

The composition is tested by `test/provider-portal-mariadb-index.test.js`.
This factory is not mounted by the production PostgreSQL `server.js`; a separate
staging server and staging-only authentication/email configuration are still required.


## Frontend contract checks

The static contract suite `test/provider-portal-mariadb-frontend-contract.test.js`
checks that the API paths used by `provider-portal.html` exist in the MariaDB
routers, that the composed router mounts invitation handling before provider
membership handling, and that SQL aliases include fields consumed by the UI.
These are source-level checks only; they do not replace HTTP integration tests
against a running MariaDB staging service.


## Standalone MariaDB staging API

The isolated entry point is `provider-portal-mariadb/staging-server.js`.
It is separate from `server.js`: it does not import `pg`, open
`DATABASE_URL`, run PostgreSQL migrations, or enable PostgreSQL tenant flags.

Start command for a dedicated Node 20 staging service:

```sh
node provider-portal-mariadb/staging-server.js
```

Required environment configuration (set only in the staging service's secret
manager, never in source control):

- `FUNERAL_SMART_ENV=staging`
- `MARIADB_HOST`, `MARIADB_PORT`, `MARIADB_USER`, `MARIADB_PASSWORD`
- `MARIADB_DATABASE` and `MARIADB_STAGING_DATABASE` must be identical; startup
  fails closed if either is missing or they differ.
- `PUBLIC_APP_URL` must be the HTTPS origin used to construct invitation links.

The standalone API exposes `/api/health`, `/api/v1/auth/login`,
`/api/v1/auth/logout`, `/api/v1/auth/me`, and mounts the provider portal at
`/api/v1/provider-portal`. Authentication uses the existing scrypt password
format and hashed opaque session tokens in MariaDB. Session cookies are
HttpOnly, SameSite=Lax, and Secure when `NODE_ENV=production`.

No email sender is configured in this entry point. Invitation creation returns
503 until a staging-only mail adapter is explicitly added. No real email can be
sent by the current standalone server. The first staging platform account must
be provisioned through a separately reviewed, one-time staging bootstrap
procedure; this server intentionally has no public account-creation endpoint.

The schema and server remain unexecuted against a real database. The staging
database must be positively identified and confirmed empty before applying the
DDL. Do not use the production PostgreSQL service or the current production
database for this work. Hestia's currently reported Node 18 runtime is below
the repository's Node >=20 engine requirement; do not deploy this backend there
until Node 20+ is installed or use a separate Node 20 staging runtime.

This is an API-only staging service. The existing frontend still uses same-origin
`/api/v1/provider-portal`; connecting it to a separate API host requires a
staging reverse-proxy path or an explicitly configured frontend API origin with
credentialed CORS and matching cookie settings. That integration is not yet
enabled.


### One-time staging administrator

After (and only after) the MariaDB staging database has been positively
identified, confirmed empty, and the schema has been applied manually, the
first platform administrator can be created with
`npm run bootstrap:mariadb-staging-admin`. The script requires
`FUNERAL_SMART_ENV=staging`, an exact match between
`MARIADB_DATABASE` and `MARIADB_STAGING_DATABASE`, and the explicit
`STAGING_BOOTSTRAP_CONFIRM=CREATE_FIRST_STAGING_ADMIN` confirmation.
Supply `STAGING_BOOTSTRAP_USERNAME`, `STAGING_BOOTSTRAP_DISPLAY_NAME`,
and `STAGING_BOOTSTRAP_PASSWORD` only through the private shell/service
environment. The script uses a MariaDB advisory lock, refuses to create a
second platform administrator, stores the same scrypt hash format used by the
existing application, and never prints the password. Remove all
`STAGING_BOOTSTRAP_*` variables immediately after the one-time run.


## Aggiornamento ramo corrente (2026-11-27)

Il porting è stato trasferito su `work/provider-area-mariadb-current`, creato dall'attuale `main` per evitare di basarsi su un ramo divergente. La PR #101 è aperta in bozza verso `main` e non è stata unita. Sono stati aggiunti gli script npm `start:mariadb-staging`, `bootstrap:mariadb-staging-admin` e `test:mariadb`. Il workflow CI è configurato per il ramo corrente e per le pull request verso `main`. Non è ancora disponibile una verifica del nuovo run CI in questa revisione. Restano obbligatori i test su MariaDB reale temporaneo, la verifica runtime Node 20+ e l'integrazione frontend/reverse proxy su staging.


### Console richieste famiglie su MariaDB (staging)

È stata aggiunta una console amministrativa separata in `/platform/richieste`, servita esclusivamente dal server MariaDB staging. Usa la sessione MariaDB e accetta soltanto ruoli `admin` o `platform_owner`. Consente di:
- consultare le richieste delle famiglie e i contatti forniti;
- scegliere esclusivamente imprese con stato `verified`;
- assegnare una richiesta con motivazione obbligatoria;
- vedere lo storico delle assegnazioni;
- segnare una richiesta come esaminata o chiuderla.

Le assegnazioni valorizzano `active_inquiry_id`, che impone al database una sola assegnazione attiva per richiesta; la chiusura revoca l'assegnazione e libera il vincolo senza cancellare lo storico. Le operazioni sono registrate in `audit_log`. Il router è isolato sotto `/api/v1/platform`; nessuna route è stata aggiunta al server PostgreSQL di produzione.

Il percorso resta staging-only e non è ancora pubblicato. Il test CI sul MariaDB reale verifica schema, vincolo di unicità, revoca e possibilità di riassegnazione; i test HTTP coprono autorizzazione, assegnazione, audit e console.


### Ingresso pubblico famiglie su MariaDB (staging)

È stato aggiunto e montato `POST /api/v1/inquiries` sul servizio MariaDB staging. Accetta anche **Cremazione + Sepoltura**, richiede consenso privacy e almeno un recapito, limita gli invii e registra le richieste come `received`, senza assegnarle automaticamente. È stato aggiunto anche l'ingresso candidature imprese, sempre con stato `pending` e senza pubblicazione automatica. Nessuna email viene inviata da questo percorso.

I test HTTP verificano richiesta combinata, obbligo di recapito/consenso e stato pending delle candidature. La pagina pubblica non viene ancora puntata al nuovo endpoint: `public/api-config.js` continua a riferirsi all'API attuale finché il servizio MariaDB staging non sarà distribuito e verificato. Non è stato cambiato alcun endpoint live.
