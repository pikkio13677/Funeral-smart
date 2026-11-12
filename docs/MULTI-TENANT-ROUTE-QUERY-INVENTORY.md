# FUNERAL SMART — Inventario rotte e query da rendere tenant-aware

Stato: inventario aggiornato con i router tenant-aware isolati nel branch `feat/multi-azienda-foundation`. I router non sono montati in `server.js`; nessuna migrazione è stata eseguita e nessun codice di produzione è stato modificato.


## Stato implementazione verificato (12 novembre 2026)

Router tenant-aware implementati come factory isolate e coperti da test unitari:
- `tenant-customers-cases-routes.js`: clienti e pratiche.
- `tenant-staff-vehicles-routes.js`: personale e veicoli.
- `tenant-inventory-tasks-routes.js`: magazzino, movimenti e attività.
- `tenant-invoices-payments-routes.js`: fatture, emissione, pagamenti e saldi.
- `tenant-dashboard-routes.js`: aggregati dashboard per azienda.

Supporto condiviso:
- `tenant-context.js`: contesto membership/azienda verificato da sessione.
- `tenant-permissions.js`: autorizzazione per ruolo aziendale.
- `company-context-routes.js`: elenco e selezione azienda nella sessione.

Ultimo controllo CI: commit `70c9a3f089e1425fa6dfa492c35d55e4fbc4aab5`, 55 test superati, 0 falliti. Sono test unitari con database simulato, non un collaudo PostgreSQL reale.

**Non confondere questi router con le rotte esistenti in `admin-routes.js`:** quelle restano le rotte single-tenant operative. I nuovi router sono implementazioni tenant-aware alternative, non ancora integrate o montate. Il passaggio richiederà separazione dei router marketplace/gestionale, verifica schema, migrazioni e test su clone PostgreSQL.

## Confine tra piattaforma e azienda

### Rotte pubbliche / marketplace (non tenant)
- `GET /api/health`
- `GET /api/v1/services`
- `GET /api/v1/providers`
- `GET /api/v1/price-lists`
- `POST /api/v1/inquiries`
- `POST /api/v1/provider-applications`

Queste rotte usano cataloghi e richieste marketplace; non devono ricevere automaticamente `company_id` solo perché il gestionale diventa multi-azienda.

### Autenticazione globale (identità, non dati di un'impresa)
- `POST /api/v1/auth/bootstrap`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/mfa/verify-login`
- `POST /api/v1/auth/mfa/setup`
- `POST /api/v1/auth/mfa/enable`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

MFA e credenziali restano proprietà dell'identità globale. Dopo login/MFA l'utente deve poter consultare le proprie membership; le API gestionali devono restare chiuse finché non viene scelta e verificata una membership attiva.

### Gestione aziendale (da riprogettare, non riutilizzare globalmente)
Le attuali rotte `GET/POST /auth/users` e `PATCH /auth/users/:id/active` operano globalmente su `app_users`. Non sono adatte agli amministratori aziendali. Sostituire il loro ruolo gestionale con inviti e membership scoped all'azienda; eventuale gestione identità globale deve essere separata e riservata alla piattaforma.

## Gestionali: copertura SQL richiesta

Tutte le query elencate devono ricevere `company_id` da `req.tenant.companyId`, mai dal body/query/browser.

| Endpoint | Tabelle e operazioni da isolare |
|---|---|
| GET /admin/dashboard | conteggi clienti, pratiche, personale, mezzi, magazzino, attività, fatture e pagamenti; ogni aggregazione e sottoquery |
| GET/POST /admin/customers | SELECT e INSERT customers |
| GET/POST /admin/cases | SELECT/INSERT funeral_cases; LEFT JOIN customers; verifica customerId |
| PATCH /admin/cases/:id/status | UPDATE funeral_cases con id + company_id |
| GET/POST /admin/staff | SELECT/INSERT staff |
| GET/POST /admin/vehicles | SELECT/INSERT vehicles |
| GET/POST /admin/inventory | SELECT/INSERT inventory_items e INSERT stock_movements nella stessa transazione |
| POST /admin/inventory/:id/movements | SELECT FOR UPDATE, UPDATE quantità e INSERT movimento; verifica eventuale caseId |
| GET/POST /admin/tasks | SELECT/INSERT tasks e join a staff/funeral_cases; verifica caseId e assignedTo |
| PATCH /admin/tasks/:id/status | UPDATE tasks con id + company_id |
| GET/POST /admin/invoices | SELECT/INSERT invoices e join a customers, funeral_cases, payments; verifica customerId e caseId |
| PATCH /admin/invoices/:id/issue | SELECT FOR UPDATE e UPDATE invoices con id + company_id |
| POST /admin/invoices/:id/payments | SELECT FOR UPDATE invoice, aggregazione payments, INSERT payment, UPDATE invoice: tutte nella stessa azienda |
| GET /admin/audit | SELECT audit_log filtrato per company_id e ruolo membership |

## Problemi di montaggio middleware rilevati

Attualmente `server.js` monta `auth.authenticate` e `auth.authorize` su tutto `/api/v1/admin`, quindi lo stesso router include:
- richieste marketplace amministrative (`/inquiries`, `/provider-applications`);
- reparti gestionali aziendali.

Questi due domini hanno autorizzazioni diverse. Nella futura modifica vanno separati in router distinti, mantenendo gli URL attuali compatibili oppure introducendo percorsi versionati con una transizione controllata. Non applicare un tenant middleware indiscriminatamente alle rotte marketplace.

## Dipendenze relazionali da controllare in scrittura

- pratica → cliente;
- fattura → cliente e pratica;
- movimento magazzino → articolo e, se presente, pratica;
- attività → pratica e personale assegnato;
- pagamento → fattura.

La validazione applicativa deve dare risposte non rivelatrici (404 per risorsa fuori tenant); i vincoli FK composti devono impedire comunque le associazioni cross-tenant a livello database.

## Ordine implementativo raccomandato

1. Separare router marketplace-admin e router gestionale senza cambiare le query.
2. Aggiungere API elenco/selezione membership e contesto sessione.
3. Implementare middleware tenant che verifica account, sessione, membership e azienda attivi ad ogni richiesta.
4. Bloccare le rotte gestionali se `req.tenant` manca; nessun fallback a ruolo globale o API key.
5. Convertire un reparto alla volta con test specifici, partendo da clienti e pratiche.
6. Convertire transazioni, join, dashboard, audit ed esportazioni.
7. Attivare il tenant gate solo dopo test completi con due aziende e regressione del flusso MFA.

## Nota di sicurezza

Non è sufficiente aggiungere `company_id` al middleware o alle sole query GET. Finché anche una sola scrittura, join, aggregazione o transazione non è tenant-aware, il multi-tenant non deve essere attivato in produzione.
