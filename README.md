# FUNERAL SMART — Backend iniziale

API Node.js + Express + PostgreSQL. È una base tecnica pronta per essere configurata su Render; non è ancora pubblicata e non contiene imprese o tariffe reali.

## Contenuto
- `src/server.js`: API REST, validazione input, rate limit, CORS e intestazioni di sicurezza.
- `db/schema.sql`: database per imprese, servizi, listini, candidature e richieste.
- `.env.example`: variabili necessarie.
- `render.yaml`: blueprint per un servizio web e un database PostgreSQL su Render. La creazione delle risorse può comportare costi secondo il piano scelto.

## Avvio locale
Richiede Node.js 20+ e PostgreSQL.

```bash
cp .env.example .env
# Compilare DATABASE_URL, ADMIN_API_KEY e CORS_ORIGIN in .env
psql "$DATABASE_URL" -f db/schema.sql
npm install
npm start
```

Test: `GET http://localhost:10000/api/health`.

## API
- `GET /api/health` — stato API e database.
- `GET /api/v1/services` — servizi attivi.
- `GET /api/v1/providers?city=Torino&service=burial` — sole imprese verificate.
- `GET /api/v1/price-lists?city=Torino&service=burial` — listini pubblicati di imprese verificate.
- `POST /api/v1/inquiries` — crea una richiesta con consenso privacy e recapito.
- `POST /api/v1/provider-applications` — candidatura impresa in stato pending, non pubblicata.
- `GET /api/v1/admin/inquiries` — richieste per amministratore (`x-admin-key`).
- `GET /api/v1/admin/provider-applications` — candidature per amministratore (`x-admin-key`).

## Esempio richiesta
```json
{
  "city": "Torino",
  "serviceType": "Rimpatrio internazionale",
  "destinationCountry": "Romania",
  "contactEmail": "famiglia@example.it",
  "privacyConsent": true
}
```

## Prima della messa online
1. Impostare segreti forti in Render; mai inserirli nel frontend o nel repository.
2. Definire informativa privacy, titolare, base giuridica, tempi di conservazione, procedure per accesso/cancellazione e contratti con fornitori.
3. Fare revisione legale e sicurezza, aggiungere autenticazione amministrativa robusta (preferibilmente account con MFA), audit log e policy di retention automatica.
4. Verificare manualmente identità e requisiti di ogni impresa prima di cambiarne lo stato in `verified`.
5. Pubblicare listini solo dopo verifica documentale; indicare IVA, inclusioni, esclusioni e costi terzi. Non sono precaricati prezzi né operatori.
6. Collegare il frontend solo dopo aver configurato `CORS_ORIGIN` con il dominio effettivo.

La API non inoltra automaticamente le richieste alle imprese e non costituisce consulenza legale o gestione di pratiche di rimpatrio.
