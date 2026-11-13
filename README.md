# FUNERAL SMART

Piattaforma web in sviluppo per imprese funebri, con area pubblica e area gestionale protetta. Il progetto comprende frontend HTML/JavaScript, API Node.js/Express e database PostgreSQL.

## Reparti gestionali

- Dashboard operativa.
- Pratiche funebri e servizi.
- Clienti e famiglie.
- Personale e ruoli.
- Veicoli e manutenzioni.
- Magazzino e movimenti.
- Attività, incarichi e scadenze.
- Fatture/documenti interni e pagamenti.
- Profilo azienda, membri, inviti e permessi multi-azienda (branch di sviluppo).

L'area pubblica consente richieste informative e candidature delle imprese. Le richieste non vengono inoltrate automaticamente a un'impresa; operatori e listini non devono essere considerati verificati finché non lo sono realmente.

## Architettura

- `index.html`: area pubblica.
- `admin.html`: area gestionale responsive.
- `server.js`: API REST, health check, CORS, rate limit e route.
- `auth.js`: login nominativo, sessioni, password, MFA/TOTP e recupero.
- `admin-routes.js`: reparti gestionali legacy/single-company.
- `tenant-*.js` e `company-context-routes.js`: contesto azienda, autorizzazioni e route multi-tenant in sviluppo.
- `schema.sql`, `gestionale.sql`, `users.sql`, `mfa.sql`: schema e migrazioni iniziali.
- `migrations/005...009.*.draft.sql`: migrazioni multi-tenant in bozza, non applicate automaticamente.
- `docs/RELEASE-CHECKLIST.md`: stato e attività necessarie prima del rilascio.

## Avvio locale

Richiede Node.js 20+ e PostgreSQL. Configurare `DATABASE_URL` in un ambiente locale di sviluppo e poi:

```bash
npm install
npm run check
npm test
npm start
```

`npm start` esegue `migrate.js` prima di avviare il server. Attualmente il runner applica soltanto le migrazioni 001–004. Le migrazioni draft 005–009 non sono incluse nel runner e non devono essere applicate a produzione senza backup, test su clone e approvazione.

## Variabili d'ambiente Render

Il Blueprint dichiara i nomi delle variabili, ma i valori devono essere configurati manualmente nel servizio Render. I segreti non devono mai essere inseriti nel repository, nel frontend o in chat.

- `DATABASE_URL`: connessione privata al database Render.
- `NODE_ENV=production`.
- `CORS_ORIGIN`: origini HTTPS autorizzate, separate da virgola.
- `BOOTSTRAP_ADMIN_TOKEN`: token iniziale per creare il primo amministratore.
- `TOTP_ENCRYPTION_KEY`: chiave casuale dedicata per cifrare i segreti MFA.
- `EMAIL_VERIFICATION_PEPPER`: segreto casuale dedicato di almeno 32 byte per HMAC dei codici email.
- `PUBLIC_APP_URL`: URL pubblico usato nei link di invito/verifica.
- `RESEND_API_KEY`: chiave API Resend con permesso Sending.
- `RESEND_FROM_EMAIL`: mittente appartenente a un dominio verificato.
- `ENABLE_MULTI_TENANT=false`: mantenere disattivato finché il rollout multi-azienda non è approvato.
- `ADMIN_API_KEY`: variabile legacy; non usarla come sostituto del login nominativo.

Per inviare email reali occorre verificare un dominio in Resend e completare i record DNS richiesti. I test automatici dell'adattatore email usano mock e non dimostrano l'invio reale.

## Test e sicurezza

```bash
npm run check
npm test
npm run test:migrations
npm run test:initial-company-bootstrap
npm run test:tenant-isolation
npm run test:mfa-break-glass
```

Le suite PostgreSQL di CI usano database temporanei. Non equivalgono a una migrazione o a un collaudo sul database Render di produzione.

La procedura di emergenza MFA è una CLI offline, non un endpoint pubblico. Non eseguirla in produzione senza verifica indipendente dell'identità, backup verificato, prova su database temporaneo e autorizzazione formale.

## Stato del rilascio

Il repository contiene una pila di pull request ancora in bozza. Il superamento dei test su un branch non significa che le modifiche siano già integrate nel branch `main` o distribuite su Render. Il multi-tenant resta disabilitato in produzione. Prima di usare dati reali sono necessari revisione e merge controllati, configurazione segreti/email, backup e restore verificati, test end-to-end, collaudo dei reparti e revisione privacy/legale.

Consultare `docs/RELEASE-CHECKLIST.md` prima di qualsiasi rilascio. Il gestionale non va presentato come sistema certificato di fatturazione elettronica o come sostituto di una verifica legale, fiscale e privacy.
