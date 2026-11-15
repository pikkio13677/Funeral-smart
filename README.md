# FUNERAL SMART — Piattaforma gestionale (prima versione)

FUNERAL SMART è in sviluppo come piattaforma web per imprese funebri. Il repository contiene un frontend pubblico dimostrativo, un'API Node.js/Express e un database PostgreSQL. Le nuove funzioni gestionali sono una prima base operativa: non sostituiscono ancora un gestionale certificato né una verifica legale, fiscale o privacy.

## File principali
- `index.html`: area pubblica dimostrativa per famiglie.
- `admin.html`: prima area gestionale responsive, protetta da chiave amministratore.
- `server.js`: API REST, validazione input, rate limit, CORS e intestazioni di sicurezza.
- `admin-routes.js`: API gestionali protette.
- `schema.sql`: schema iniziale per imprese, servizi, listini, candidature e richieste.
- `gestionale.sql`: migrazione additiva per pratiche funebri, clienti, personale, veicoli, magazzino, attività, fatture e pagamenti.
- `api-config.js`: URL del backend per il frontend pubblico (da configurare).
- `render.yaml`: Blueprint Render per servizio web e database PostgreSQL.

## Moduli gestionali inclusi nella prima versione
- Dashboard: pratiche attive, clienti, personale, mezzi disponibili, scorte basse, attività aperte e importi da incassare.
- Pratiche/funerali: apertura pratica, dati essenziali, stato e importo preventivato.
- Clienti e famiglie: anagrafiche e recapiti.
- Personale: collaboratori e ruoli.
- Veicoli: mezzi, disponibilità e manutenzioni.
- Magazzino: articoli, giacenze, soglie minime e movimenti di carico/scarico.
- Attività: incarichi, priorità, scadenze e stato.
- Fatture e pagamenti: registrazione documenti e incassi con controllo del residuo.
- Area pubblica: richieste informative e consultazione di eventuali listini verificati.

## Configurazione database
Richiede Node.js 20+ e PostgreSQL. Eseguire le migrazioni sul database corretto, una volta sola per ogni ambiente (gli script sono ripetibili):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f gestionale.sql
npm install
npm run check
npm start
```

Su Render, usare il valore privato di `DATABASE_URL` del database associato. Non inserire mai credenziali o chiavi nel repository. La migrazione `gestionale.sql` non è eseguita automaticamente dal Blueprint: va applicata al database prima di usare i nuovi moduli.

## Configurazione Render
Impostare nelle Environment Variables del servizio:
- `DATABASE_URL`: collegamento privato al database Render.
- `ADMIN_API_KEY`: chiave casuale lunga e non riutilizzata.
- `CORS_ORIGIN`: origine HTTPS autorizzata del frontend, senza slash finale.
- `NODE_ENV=production`.

La chiave `ADMIN_API_KEY` non va mai inserita in `index.html`, `api-config.js`, file pubblici o messaggi. Per la prima area gestionale viene digitata dall'amministratore nel browser e resta solo in `sessionStorage fino alla chiusura della sessione. È una protezione provvisoria: prima dell'uso con dati reali sostituirla con login nominativi, ruoli, MFA, sessioni server-side e audit log.

## Email transazionali tramite Resend

Le richieste pubbliche e le candidature vengono salvate nel database prima di tentare l'invio delle notifiche. Un errore di Resend non annulla la registrazione né espone la chiave API.

Configurare esclusivamente nel servizio Render:
- `RESEND_API_KEY`: chiave Resend con permesso Sending.
- `RESEND_FROM_EMAIL`: mittente autorizzato su un dominio verificato.
- `ADMIN_NOTIFICATION_EMAIL`: casella che riceve le nuove richieste e le candidature.
- `PUBLIC_APP_URL`: URL HTTPS pubblico del servizio, usato per collegare l'area gestionale.

Flussi previsti:
- conferma al richiedente, se ha fornito un indirizzo email;
- avviso all'amministratore per ogni nuova richiesta;
- avviso all'amministratore per ogni nuova candidatura, che resta in attesa di verifica.

Le email non inoltrano automaticamente le richieste alle imprese. Non includono le note libere inviate dall'utente. Non inserire mai chiavi API in GitHub o in chat.

## API gestionali
Tutte le rotte seguenti richiedono l'header `x-admin-key`:
- `GET /api/v1/admin/dashboard`
- `GET|POST /api/v1/admin/customers`
- `GET|POST /api/v1/admin/cases`, `PATCH /api/v1/admin/cases/:id/status`
- `GET|POST /api/v1/admin/staff`
- `GET|POST /api/v1/admin/vehicles`
- `GET|POST /api/v1/admin/inventory`, `POST /api/v1/admin/inventory/:id/movements`
- `GET|POST /api/v1/admin/tasks`, `PATCH /api/v1/admin/tasks/:id/status`
- `GET|POST /api/v1/admin/invoices`, `POST /api/v1/admin/invoices/:id/payments`

API pubbliche:
- `GET /api/health` — stato API e database.
- `GET /api/v1/services` — servizi attivi.
- `GET /api/v1/providers` e `GET /api/v1/price-lists` — sole imprese verificate/listini pubblicati.
- `POST /api/v1/inquiries` — richiesta informativa con consenso e recapito.
- `POST /api/v1/provider-applications` — candidatura impresa non pubblicata.

## Verifiche indispensabili prima dei dati reali
1. Eseguire la migrazione e verificare `/api/health` e tutte le rotte con dati di prova.
2. Configurare CORS con il dominio reale del frontend.
3. Implementare autenticazione nominativa e permessi per ruolo; la chiave amministratore è solo un ponte per test controllati.
4. Aggiungere audit log, backup automatici e test di ripristino, retention e procedure di cancellazione.
5. Definire informativa privacy, titolare, base giuridica, tempi di conservazione e contratti con i fornitori. I dati relativi al decesso e alle famiglie richiedono particolare cautela.
6. Verificare con professionisti competenti gli aspetti fiscali, documentali e normativi. Non usare i dati demo come prezzi o preventivi reali.

Le richieste pubbliche non vengono inoltrate automaticamente alle imprese. Non sono precaricati operatori o listini reali.
