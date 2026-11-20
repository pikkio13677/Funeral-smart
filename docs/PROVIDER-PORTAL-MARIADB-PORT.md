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

Branch isolato: `work/provider-area-mariadb`. Nessuna modifica a `main`, nessun deploy e nessuna migrazione eseguita.

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
1. Definire prima lo schema MariaDB completo delle tabelle marketplace dipendenti (`providers`, `provider_services`, `service_types`, `price_lists`, `inquiries`, `inquiry_provider_assignments`) e confrontare tipi e chiavi con il database di test effettivamente creato sull'hosting.
2. Scrivere una migrazione MariaDB separata, versionata e non collegata al vecchio `migrate.js` PostgreSQL.
3. Introdurre un modulo database MariaDB con pool `mysql2/promise`; mantenere le query isolate e parametrizzate.
4. Portare il middleware di contesto, le route dashboard/inquiry, inviti e collaboratori preservando i controlli tenant/provider e le transazioni.
5. Aggiungere test automatici MariaDB su database usa-e-getta: accesso non autenticato, isolamento fra imprese, invito con token hash, accettazione/rifiuto atomici, protezione ultimo amministratore e statistiche.
6. Solo dopo test verdi, predisporre le variabili ambiente e l'avvio Node >=20 sul server di staging. Le email devono essere disabilitate o intercettate in test.
7. Abilitare il flag del portale esclusivamente nell'ambiente di test e collaudare da smartphone.

## Blocco attuale
Non è ancora sicuro scrivere la migrazione definitiva: nel repository le API dipendono da tabelle marketplace e richieste create da migrazioni precedenti, mentre non è stato ancora verificato lo schema reale MariaDB sull'hosting. Inventare tipi o chiavi esterne potrebbe produrre una migrazione che sembra corretta ma non si avvia.

## Vincoli
- Nessuna modifica al database PostgreSQL esistente.
- Nessuna esecuzione di migrazioni su produzione.
- Nessuna attivazione di `ENABLE_PROVIDER_PORTAL` finché il porting e i test non sono completati.
- Nessuna email reale durante i test.
- Conservare la demo e le pagine attuali; non sostituirle con una nuova interfaccia prima del collaudo API.
