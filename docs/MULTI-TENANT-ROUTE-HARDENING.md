# Audit rotte gestionali e piano di isolamento tenant

## Stato e limiti

Audit statico del branch `feat/multi-azienda-foundation`. Nessuna rotta viene montata o modificata in questo documento. Il backend live continua a usare il comportamento precedente. Le migrazioni 005/006 restano bozze e il middleware tenant resta scollegato.

## Confini applicativi osservati

- `server.js` monta `auth.authenticate` e `auth.authorize` su `/api/v1/admin`, poi monta `admin-routes.js`.
- Le rotte marketplace `GET /api/v1/admin/inquiries` e `GET /api/v1/admin/provider-applications` sono dichiarate direttamente in `server.js`, prima del router gestionale.
- Il router `admin-routes.js` contiene i reparti dell'impresa e un registro attività; non è un router tenant-aware.
- `auth.authorize` usa il ruolo globale `req.user.role`. Non deve essere riutilizzato come autorizzazione aziendale nel modello multi-tenant.
- Il middleware tenant ricava membership, azienda e ruolo dal database, ma non è ancora montato.

## Inventario delle rotte gestionali da convertire

| Percorso | Dati coinvolti | Regole tenant richieste |
|---|---|---|
| GET /dashboard | pratiche, clienti, personale, mezzi, scorte, attività, fatture, pagamenti | Ogni conteggio e aggregazione deve filtrare la stessa company_id |
| GET/POST /customers | customers | Lettura e creazione nella sola azienda attiva |
| GET/POST /cases | funeral_cases, customers | Filtrare entrambe le tabelle; verificare customer_id nella stessa azienda |
| PATCH /cases/:id/status | funeral_cases | UPDATE con id e company_id |
| GET/POST /staff | staff | Filtrare e scrivere nella sola azienda |
| GET/POST /vehicles | vehicles | Filtrare e scrivere nella sola azienda |
| GET/POST /inventory | inventory_items, stock_movements | Transazione tenant-aware su entrambe le tabelle |
| POST /inventory/:id/movements | inventory_items, stock_movements, funeral_cases | Lock, aggiornamento e riferimenti pratica/articolo vincolati alla stessa azienda |
| GET/POST /tasks | tasks, staff, funeral_cases | Join e riferimenti assegnatario/pratica nella stessa azienda |
| PATCH /tasks/:id/status | tasks | UPDATE con id e company_id |
| GET/POST /invoices | invoices, customers, funeral_cases, payments | Tutti i join e riferimenti devono appartenere alla stessa azienda |
| PATCH /invoices/:id/issue | invoices | Lock e UPDATE con id e company_id |
| POST /invoices/:id/payments | invoices, payments | Lock, saldo, inserimento pagamento e aggiornamento fattura nella stessa azienda |
| GET /audit | audit_log | Il log deve avere un contesto aziendale esplicito; non esporre il log globale a un admin aziendale |

## Rischi concreti individuati nel codice attuale

1. Le query dei reparti non contengono filtri `company_id`. Non è sicuro montare semplicemente `tenant-context` davanti alle rotte attuali: il contesto sarebbe verificato, ma le query continuerebbero a leggere e modificare i dati di tutte le aziende.
2. Le transazioni di magazzino e fatturazione usano identificativi senza vincolo aziendale nelle clausole `WHERE` e nei riferimenti. Un UUID appartenente a un'altra azienda potrebbe essere utilizzato se arrivasse alla rotta.
3. I join di pratiche/clienti, attività/personale/pratiche e fatture/clienti/pratiche/pagamenti sono basati solo sugli ID. Devono includere l'uguaglianza della company_id oppure essere garantiti da foreign key composte dopo migrazione e backfill.
4. Il dashboard esegue query separate e aggregazioni globali: tutte devono ricevere il medesimo company_id verificato.
5. `GET /audit` legge l'intero `audit_log` e controlla `req.user.role`. Va riprogettato per distinguere audit di piattaforma e audit aziendale.
6. L'audit automatico in `admin-routes.js` scrive l'utente ma non una company_id. Va esteso solo dopo aver definito lo schema e la separazione dei log.
7. L'errore di duplicato per codice pratica, targa, SKU e numero fattura oggi presume unicità globale. Dopo la migrazione le constraint devono essere ridefinite per azienda, senza perdere lo storico.
8. Il router marketplace e quello gestionale devono mantenere autenticazione e policy differenti; il middleware tenant non va applicato globalmente a `/api/v1/admin`.

## Contratto richiesto per le future query

- Leggere `companyId` esclusivamente da `req.tenant.companyId`; mai dal body, query string, header o parametri URL.
- Ogni SELECT/UPDATE/DELETE di una tabella tenant-scoped deve includere `company_id = $n`.
- Ogni INSERT deve scrivere `company_id` dal contesto server-side.
- Ogni join tra tabelle tenant-scoped deve legare sia la chiave logica sia `company_id`.
- Le transazioni devono mantenere il medesimo tenant in tutte le query.
- Gli ID non autorizzano da soli l'accesso: un ID valido di un altro tenant deve restituire 404 o 403 senza rivelare dati.
- I riferimenti opzionali (customer, case, staff, item, invoice) devono essere validati nella stessa azienda prima dell'inserimento.
- Le route marketplace restano fuori da questo contratto e richiedono policy platform-admin esplicite.

## Sequenza di conversione sicura

1. Preparare un database clone ripristinato da backup e verificare schema effettivo di sessioni, utenti e tabelle.
2. Completare e testare migrazione, backfill e constraint composite sul clone; non eseguire le bozze 005/006 in produzione.
3. Integrare il router di selezione azienda e il middleware tenant in un prefisso dedicato, non sul router marketplace.
4. Convertire prima customers e staff, poi cases e vehicles, quindi tasks e inventory, infine invoices/payments.
5. Convertire dashboard e audit solo quando i dati sottostanti sono già isolati.
6. Per ogni reparto aggiungere test PostgreSQL con due aziende: lettura, modifica, IDOR, creazione con riferimento cross-tenant, join, transazione e rollback.
7. Solo dopo test completi e revisione autorizzare merge e deploy.

## Criteri di accettazione

- Due aziende Alfa e Beta possono usare lo stesso codice pratica, targa, SKU e numero fattura se il requisito di business lo consente.
- Un utente Alfa non può leggere, modificare, associare o pagare record Beta neppure conoscendone l'UUID.
- Un utente senza membership attiva o con azienda sospesa non entra nei reparti.
- Cambiare company_id nel browser non cambia il tenant effettivo.
- Revoca membership e cambio azienda sono coerenti con le sessioni già aperte.
- Le rotte marketplace e le funzioni platform-admin restano separate dai ruoli aziendali.

## Decisione tecnica

Non applicare wrapper SQL generici, sostituzioni testuali o middleware globale per aggiungere company_id: potrebbero lasciare join, subquery e transazioni non protetti. Convertire le query esplicitamente, reparto per reparto, e verificare con PostgreSQL reale su clone.
