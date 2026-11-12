# FUNERAL SMART — Piano di implementazione incrementale e contratto API

Stato: progettazione eseguibile per fasi, non ancora implementazione.  
Branch di lavoro: `feat/multi-azienda-foundation`.

## Decisione architetturale

Separare tre concetti che oggi sono confusi:
1. **Identità globale**: `app_users` rappresenta una persona e mantiene credenziali, MFA e sessioni.
2. **Azienda**: `companies` rappresenta un'impresa cliente SaaS.
3. **Membership**: `company_memberships` lega una persona a un'azienda e contiene ruolo/stato di accesso.

Il ruolo non deve più essere letto da `app_users.role` per autorizzare i reparti aziendali. Il ruolo effettivo è quello della membership attiva nel tenant richiesto. L'eventuale amministratore della piattaforma è un privilegio separato, esplicito e non derivato dal fatto di essere amministratore di una singola impresa.

## Contesto tenant: contratto server-side

Ogni richiesta privata deve arrivare a un middleware dopo l'autenticazione:
- verificare la sessione globale;
- ottenere l'azienda attiva dalla sessione o da un identificatore di contesto non considerato attendibile;
- verificare sul database che l'utente abbia una membership `active` per quell'azienda;
- costruire `req.tenant = { companyId, membershipId, role }` usando esclusivamente i valori verificati dal database;
- rifiutare la richiesta se manca un contesto valido (401/403), senza fallback al vecchio accesso globale.

Il client può chiedere di cambiare azienda, ma il server deve verificare nuovamente la membership. Non accettare un ruolo o un company_id come prova di autorizzazione dal body, query string o local storage.

## API proposte

- `GET /api/v1/auth/companies`: aziende per cui l'utente ha membership attiva.
- `POST /api/v1/auth/active-company`: seleziona un'azienda; body con identificativo azienda, verificato server-side; aggiorna il contesto di sessione.
- `GET /api/v1/auth/me`: restituisce identità e azienda attiva con ruolo membership, non un ruolo tenant globale.
- `GET /api/v1/company/profile`: profilo della sola azienda attiva.
- `PATCH /api/v1/company/profile`: modifica profilo consentita al company-admin.
- `GET /api/v1/company/members`: membri della sola azienda attiva.
- `POST /api/v1/company/invitations`: invita un utente nella sola azienda attiva.
- `PATCH /api/v1/company/members/:membershipId`: cambia ruolo/stato solo all'interno della stessa azienda; impedire la rimozione dell'ultimo admin attivo.
- Le rotte già esistenti sotto `/api/v1/admin` verranno mantenute inizialmente per compatibilità di percorso, ma protette da tenant middleware e query tenant-scoped; il nome `admin` non deve implicare privilegi di piattaforma.

## Strategia di compatibilità e rollout

### PR A — Solo schema sul clone
- Migrazione separata e versionata.
- Creare una sola azienda iniziale per i dati gestionali esistenti.
- Creare membership per gli account esistenti dopo aver definito quale account amministra l'azienda.
- Aggiungere colonne tenant nullable, backfill, controlli di conteggio e relazioni.
- Creare vincoli/indici composti prima di rimuovere l'unicità globale.
- Eseguire restore e test ripetibili su copia del database.
- Non includere la migrazione in `migrate.js` finché il test su clone non è approvato.

### PR B — Identità e selezione azienda, senza esporre reparti multipli
- Aggiungere il campo di contesto alla sessione o una tabella separata di contesto sessione.
- Aggiungere endpoint elenco/selezione azienda.
- Tenere il sistema in modalità single-tenant: ogni account esistente ha una sola membership.
- Nessun utente può ancora creare una seconda azienda o invitare utenti esterni.

### PR C — Middleware e autorizzazione
- Introdurre `req.tenant` verificato.
- Separare `platformAdmin`, `companyAdmin`, `manager`, `operator`, `warehouse`, `accounting`.
- Applicare una matrice permessi per metodo e risorsa.
- Disabilitare il fallback legacy `ADMIN_API_KEY` sulle API gestionali quando la modalità tenant è attiva.

### PR D — Query tenant-aware per reparto
Ordine proposto:
1. clienti e pratiche;
2. personale e veicoli;
3. magazzino e movimenti;
4. attività;
5. fatture e pagamenti;
6. dashboard, audit ed esportazioni.

Ogni SELECT/INSERT/UPDATE/DELETE e ogni transazione deve contenere company_id ricavato da `req.tenant`. Ogni relazione tra record deve essere verificata con chiavi composte o query che richiedono entrambi `id` e `company_id`.

### PR E — Gestione membri
- Inviti con token monouso, scadenza e hash a riposo.
- Accettazione invito collegata a identità globale esistente o nuova identità.
- Membership creata nella stessa transazione dell'accettazione.
- Revoca membership immediata; nessun trasferimento automatico dei dati tra aziende.

### PR F — Pannello piattaforma e piani
- Area piattaforma separata e protetta.
- Aziende, stato, piano, scadenza e fatturazione.
- Nessun accesso ordinario ai dati sensibili delle imprese da parte del supporto; eventuale accesso assistito temporaneo deve essere motivato, limitato e auditato.
- Pagamenti SaaS e webhook idempotenti in una fase separata.

## Criteri minimi di accettazione

Con due aziende A e B:
- l'utente A non può leggere, modificare, cancellare o inferire conteggi di B;
- cambiare un UUID nella URL o nel body non permette IDOR;
- un operatore non può gestire membri, profilo o fatture se il ruolo non lo consente;
- revoca/sospensione membership blocca subito le richieste;
- ogni dashboard, ricerca, report, export, audit e aggregazione rispetta il tenant;
- riferimenti incrociati (cliente/pratica/fattura/pagamento/articolo/personale) sono respinti dal database;
- il comportamento single-tenant attuale resta invariato per gli utenti esistenti;
- MFA, cookie HttpOnly, rate limit e hash password restano attivi.

## Blocco esplicito

Non implementare un middleware isolato e non aggiungere un tenant_id soltanto alle query GET. Il passaggio a multi-tenant è accettabile solo quando tutte le operazioni di lettura e scrittura, incluse transazioni e join, sono protette e coperte da test cross-tenant.
