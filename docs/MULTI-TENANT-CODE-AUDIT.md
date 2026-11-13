# FUNERAL SMART — Ricognizione codice per il multi-tenant

Data: 2026-11-12  
Branch: `feat/multi-azienda-foundation`  
Stato: sola analisi statica dei file nel repository; nessun collegamento al database di produzione e nessuna modifica runtime.

## 1. Architettura rilevata

- `server.js` crea un unico pool PostgreSQL e monta l'autenticazione sotto `/api/v1/auth`.
- Le rotte gestionali sono montate sotto `/api/v1/admin` e passano da `authenticate`, `authorize` e dal router in `admin-routes.js`.
- `auth.js` autentica account globali in `app_users`; il ruolo è memorizzato direttamente sull'utente.
- `admin-routes.js` contiene le query dei reparti e il registro attività.
- `admin.html` è il client gestionale che richiama le API.
- `migrate.js` applica automaticamente, all'avvio del servizio, tutti i file registrati nell'array `migrations`. Per questo una bozza SQL non deve essere aggiunta all'array prima del collaudo.

## 2. Superfici gestionali da rendere tenant-aware

| Area | Endpoint osservati | Tabelle principali |
|---|---|---|
| Dashboard | GET /dashboard | funeral_cases, customers, staff, vehicles, inventory_items, tasks, invoices, payments |
| Clienti | GET/POST /customers | customers |
| Pratiche | GET/POST /cases, PATCH /cases/:id/status | funeral_cases, customers |
| Personale | GET/POST /staff | staff |
| Veicoli | GET/POST /vehicles | vehicles |
| Magazzino | GET/POST /inventory, POST /inventory/:id/movements | inventory_items, stock_movements, funeral_cases |
| Attività | GET/POST /tasks, PATCH /tasks/:id/status | tasks, staff, funeral_cases |
| Fatture | GET/POST /invoices, PATCH /invoices/:id/issue, POST /invoices/:id/payments | invoices, payments, customers, funeral_cases |
| Audit | GET /audit | audit_log |

Le rotte auth comprendono inoltre gestione utenti globale (`GET/POST /users`, `PATCH /users/:id/active`), login, sessioni e MFA. Queste operazioni devono essere ridisegnate distinguendo amministrazione della piattaforma, amministrazione della singola azienda e appartenenza dell'utente.

## 3. Blocchi di sicurezza da risolvere prima di attivare aziende multiple

1. **Identità e ruoli globali:** oggi `app_users.role` è un ruolo unico per account. Con membership aziendali il ruolo deve essere verificato nel contesto dell'azienda attiva; un utente può avere ruoli diversi in aziende diverse.
2. **Sessione e tenant attivo:** la sessione oggi identifica soltanto l'utente. Occorre una selezione azienda esplicita e un contesto server-side verificato contro una membership attiva. Non fidarsi di `company_id` inviati dal browser.
3. **Tutte le query:** le query gestionali lette nel router non hanno filtro aziendale. Filtrare soltanto le liste non basta: ogni SELECT, INSERT, UPDATE, movimento e join deve essere vincolato al tenant.
4. **Riferimenti incrociati:** validare che customer, case, staff, item, invoice e payment collegati appartengano tutti alla stessa azienda. Le FK singole attuali non garantiscono questo isolamento.
5. **Vincoli univoci:** `case_code`, `plate`, `sku`, `invoice_number` sono definiti con unicità globale nello schema gestionale. Va decisa e testata l'unicità per azienda prima di sostituire i vincoli esistenti.
6. **Creazione account:** oggi la creazione utenti è globale e non crea membership. Va sostituita con invito/creazione utente + membership aziendale atomica.
7. **Audit:** il log attuale non contiene `company_id`; distinguere audit della piattaforma e audit aziendale, impedendo a un admin tenant di vedere eventi altrui.
8. **Ruoli e rotte:** l'autorizzazione attuale usa il ruolo globale e consente, per esempio, al manager le GET; va applicata la matrice permessi per membership su ogni endpoint.
9. **Marketplace pubblico:** `providers`, `provider_services`, `price_lists`, `provider_applications` e `inquiries` hanno finalità diverse dal gestionale privato. Non assegnare loro un tenant automaticamente.

## 4. Dipendenze e ordine consigliato

### Fase A — Contratto di identità
Definire piattaforma-admin separato da azienda-admin, ruoli per membership, selezione azienda, gestione inviti e comportamento degli utenti multi-azienda.

### Fase B — Migrazione e integrità
Su un clone ripristinato del database: creare aziende e membership, backfill del tenant storico, verifiche di conteggio e relazioni, vincoli compositi e unicità per azienda. Nessuna colonna obbligatoria finché il backfill non è provato.

### Fase C — Middleware
Implementare un middleware che risolva l'azienda attiva da sessione e membership sul server. La richiesta senza tenant valido deve essere negata sulle rotte private.

### Fase D — Repository/query layer
Centralizzare le query gestionali o introdurre helper che richiedano esplicitamente il tenant; evitare query tenant-blind. Includere dashboard, join, transazioni, audit ed esportazioni.

### Fase E — Client web
Aggiungere selettore azienda, profilo aziendale e gestione utenti/membership. Il client non decide mai l'autorizzazione.

### Fase F — Test
Test automatizzati con due aziende e utenti distinti, inclusi IDOR con UUID validi dell'altro tenant, ruoli diversi, revoca membership, dashboard, pagamenti, magazzino, concorrenza, audit e regressione singola azienda.

### Fase G — Release
Backup e restore provati; migrazione su clone; revisione PR; deploy controllato e rollback. Il database di produzione non va migrato finché ogni test di isolamento non passa.

## 5. Esito della ricognizione

Il branch contiene ora una proposta di schema, ma **non contiene ancora un'implementazione multi-tenant sicura**. La ricognizione mostra che la trasformazione coinvolge autenticazione, membership, tutte le query gestionali, vincoli e interfaccia. La prossima modifica eseguibile dovrà essere una serie di piccoli cambiamenti testabili, non un semplice middleware che aggiunge un filtro parziale.

## 6. File esaminati

- `server.js`
- `auth.js`
- `admin-routes.js`
- `admin.html`
- `schema.sql`
- `gestionale.sql`
- `users.sql`
- `mfa.sql`
- `migrate.js`
- `package.json`
- `docs/MULTI-TENANT-PLAN.md`
- `migrations/005_multi_tenant_foundation.draft.sql`
