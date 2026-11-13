# PIKKIO21 — checkpoint completo FUNERAL SMART
Aggiornato: 13 novembre 2026

Questo documento consolida lo stato noto del progetto dall'avvio del lavoro fino a questo checkpoint. Serve come punto di ripresa: quando l'utente scrive **PIKKIO21**, ripartire da qui senza ripetere verifiche già concluse.

## 1. Obiettivo e prodotto
FUNERAL SMART è una piattaforma per il settore funebre, con interfaccia italiana/inglese, area gestionale, gestione aziende e collaboratori, pratiche, clienti, personale, veicoli, magazzino, attività, fatture e pagamenti. Sono previste funzioni pubbliche per consultare servizi/listini/imprese verificate e inviare richieste di assistenza o candidature di imprese. Le richieste pubbliche attualmente vengono registrate ma non inoltrate automaticamente alle imprese: il frontend/backend lo dichiarano esplicitamente.

## 2. Repository e infrastruttura
- GitHub: https://github.com/pikkio13677/Funeral-smart
- Branch principale: `main`
- Branch pre-rilascio: `release/funeral-smart-preflight`
- Backend Render: `funeral-smart-api`
- Database Render PostgreSQL: `funeral-smart-db`
- `/api/health` è stato verificato in precedenza con risposta OK e database connected.
- Render non è collegato agli strumenti di questa sessione; non si possono leggere o modificare direttamente le variabili ambiente Render.
- `render.yaml` definisce un servizio web e un database, ma non un ambiente staging separato.
- `ENABLE_MULTI_TENANT=false` in configurazione Render; multi-tenant e migrazioni draft restano disattivati in produzione.
- `api-config.js` è vuoto sia in `main` sia nel branch release. Il frontend pubblico non è collegato al backend live.
- Nessun deploy, merge o cambiamento del database di produzione è stato eseguito durante le verifiche qui documentate.

## 3. Stato GitHub e CI
- Branch `release/funeral-smart-preflight`.
- Ultimo commit noto dopo il salvataggio di questa documentazione: commit del checkpoint PIKKIO21 (vedere cronologia GitHub).
- Commit `73caabf24bd62dba9f40926d3e3797deb4461cfb`: workflow `Funeral Smart checks` run [43507991218](https://github.com/pikkio13677/Funeral-smart/actions/runs/43507991218) concluso SUCCESS; workflow `Multi-tenant branch checks` run [43507991154](https://github.com/pikkio13677/Funeral-smart/actions/runs/43507991154) concluso SUCCESS.
- Commit precedente `43ab56a3a243ac923ff9a77e1435d0d0766e6514): entrambi i workflow verdi (run 43507669127 e 43507669303).
- Commit precedente `8e652cb38ad45940d2a7e9e6672a0f96e7a75b2e): entrambi i workflow verdi (run 43507833113 e 43507833345).
- PR aperte in bozza: 21 al controllo. In particolare PR #28, #29, #30 sono parte della catena di hardening MFA/sicurezza. Le PR non sono state unite; occorre pianificare l'integrazione ordinata della catena completa prima del rilascio.
- La checklist di rilascio è `docs/RELEASE-CHECKLIST.md`.

## 4. Backup e ripristino PostgreSQL — COMPLETATO
Il 13 novembre 2026 sono stati verificati i file:
- `funeral-smart-20261112-175532 (1).dump`
- `funeral-smart-20261112-175532 (1).dump.enc`

Il dump cifrato usa AES-256-CBC + PBKDF2 con 200.000 iterazioni e header `Salted__`. La passphrase è stata inserita localmente dall'utente in Termux e non condivisa in chat. L'archivio decrittografato è stato letto con `pg_restore -l`; SHA256 del dump decrittografato e del dump non cifrato coincidono:
`d908945e14e60bf6de677677e6c7a374fd2eb8ee0cf13c9e95af0a9d328779be`.

Restore riuscito in un database temporaneo locale `funeral_test` con PostgreSQL 18.2, opzioni `--verbose --exit-on-error --no-owner --no-privileges`. Verificate tutte le 20 tabelle pubbliche:
- app_mfa_challenges 0
- app_sessions 1
- app_users 1
- audit_log 3
- customers 1
- funeral_cases 1
- inquiries 0
- inventory_items 0
- invoices 3
- payments 3
- price_lists 0
- provider_applications 0
- provider_services 0
- providers 0
- schema_migrations 4
- service_types 4
- staff 0
- stock_movements 0
- tasks 1
- vehicles 0

Il cluster temporaneo Termux è stato arrestato. Database di produzione Render mai toccato.

## 5. Sicurezza, autenticazione e MFA
- MFA/2FA dell'amministratore attiva e verificata durante i precedenti checkpoint.
- Test MFA challenge single-use/replay, recovery e rollback presenti nei controlli automatici.
- Ruoli applicativi: `admin`, `manager`, `operator`, `warehouse`, `accounting`; non introdurre ruoli alternativi non previsti.
- `platform_admin` non è un ruolo tenant.
- Rotte tenant protette da autenticazione e contesto aziendale; test permessi e isolamento tra aziende presenti.
- Bootstrap iniziale azienda richiede amministratore iniziale, MFA e conferma esplicita di proprietà dati legacy.
- Audit mutazioni tenant dopo risposte 2xx, senza salvare body o dati personali; acceptance invito registra audit nella stessa transazione.
- Le migrazioni draft 005–009 non sono applicate a produzione. `migrate.js` applica solo migrazioni base 001–004.
- Le migrazioni draft richiedono ulteriore revisione di FK composte, backfill, ordine, rollback e compatibilità schema live.
- Le sei tabelle considerate globali/platform sono `service_types`, `providers`, `provider_services`, `price_lists`, `provider_applications`, `inquiries`; prima del lancio pubblico restano da completare anti-abuso, retention e accesso minimo ai dati personali di candidature/richieste.

## 6. Email e inviti
- Resend adapter implementato in `resend-email.js` per inviti e codici verifica.
- Richiede `RESEND_API_KEY`, `RESEND_FROM_EMAIL` su dominio verificato e `PUBLIC_APP_URL`; i valori segreti non vanno mai incollati in chat.
- Test automatici simulano le API Resend; non è stato eseguito invio reale.
- `auth.js` è stato corretto per compatibilità con schema legacy: verifica email disabilitata se `ENABLE_MULTI_TENANT` non è true.
- Registrazione da invito, richiesta/conferma codice email e acceptance UI sono state verificate staticamente; non è un collaudo end-to-end su Render.
- L'accettazione richiede autenticazione, identità email verificata corrispondente e invito valido.
- Endpoint verifica email restano disabilitati in produzione finché multi-tenant e migrazioni non sono attivati in modo controllato.
- Il mittente di default Resend onboarding@resend.dev non viene usato in produzione.

## 7. API pubbliche e protezione anti-abuso
- `server.js` usa Helmet, CORS con origini consentite, limite JSON 30kb e rate limit generale API.
- Al commit `43ab56a3a243ac923ff9a77e1435d0d0766e6514` è stato impostato `trust proxy = 1` per Render e un rate limit dedicato di 10 richieste/ora per IP su `POST /api/v1/inquiries` e `POST /api/v1/provider-applications`.
- Il limiter usa lo store in memoria standard di express-rate-limit: con più istanze o riavvii frequenti non è un limite globale persistente; prima di traffico significativo valutare store condiviso e ulteriori misure anti-spam.
- Validazione Zod per le richieste pubbliche; consenso privacy obbligatorio; almeno un recapito email o telefono richiesto.
- Richieste ricevute non sono inoltrate automaticamente a imprese.

## 8. Frontend
- `index.html` è presente in `main` e nel branch release e contiene la UI pubblica, la ricerca listini e il modulo richiesta.
- `api-config.js` resta vuoto intenzionalmente. Non collegare il frontend pubblico al database di produzione finché non esiste staging e non sono stati collaudati invio, privacy, CORS e flussi end-to-end.
- `admin.html` contiene area gestionale, sicurezza MFA, flusso registrazione/accettazione invito e aree amministrative; verificato staticamente, ma serve collaudo end-to-end.

## 9. Cronologia checkpoint precedenti (riassunto)
Nel lavoro precedente sono stati creati checkpoint progressivi PIKKIO5, PIKKIO6, PIKKIO7, PIKKIO8, PIKKIO9, PIKKIO11, PIKKIO12, PIKKIO13 e successivi. I passaggi principali registrati:
- impostazione FUNERAL SMART e repository GitHub;
- configurazione backend Render e database PostgreSQL;
- verifica health API e connessione database;
- predisposizione interfaccia italiana/inglese;
- gestione utenti, ruoli e MFA amministratore;
- correzioni dei flussi login, sessioni e recovery;
- integrazione Resend per inviti/verifica email;
- costruzione area multi-azienda e moduli gestionali;
- predisposizione audit log, isolamento tenant e bootstrap aziendale;
- procedure backup/restore e test locali;
- preparazione pre-rilascio con branch dedicato, checklist e CI.
I checkpoint storici completi sono stati conservati nella memoria conversazionale dove disponibili; questo file registra lo stato tecnico consolidato e i vincoli correnti.

## 10. Cosa manca per completare e rilasciare
Ordine consigliato, senza ripetere i test già verdi:
1. Predisporre staging separato (servizio e DB separati, non produzione) e definire URL frontend/backend.
2. Verificare in Render la presenza delle variabili email: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `PUBLIC_APP_URL`, senza esporre i valori in chat.
3. Eseguire invio email di prova autorizzato e verificare ricezione reale, invito e codice verifica.
4. Eseguire test end-to-end su staging: richiesta famiglia, candidature imprese, ricerca listini, login, MFA, invito, registrazione, verifica email, accettazione, ruoli, moduli gestionali, logout e audit.
5. Completare audit anti-spam, privacy, retention, accesso admin e store rate-limit condiviso se necessario.
6. Rivedere tutte le PR aperte e integrare ordinatamente la catena di sviluppo; risolvere conflitti e rieseguire CI sul commit candidato.
7. Verificare schema live, migrazioni e piano rollback; non applicare migrazioni draft a produzione senza approvazione esplicita.
8. Configurare `api-config.js` solo per l'ambiente appropriato; pubblicare frontend/backend soltanto dopo esito positivo staging.
9. Eseguire backup verificato prima di qualsiasi migrazione o deploy produttivo e predisporre monitoraggio post-rilascio.

## 11. Regole operative per riprendere il lavoro
- Quando l'utente scrive **PIKKIO21**, riprendere da questo checkpoint.
- Utente opera principalmente da Samsung Android e preferisce istruzioni semplici, una sola azione alla volta, senza chiedere copia/incolla di codice se l'operazione può essere eseguita direttamente tramite GitHub.
- Fare modifiche direttamente nel branch release quando possibile; preservare codice già funzionante e non ripetere verifiche concluse.
- Non chiedere né accettare password, API key, passphrase o altri segreti in chat.
- Non eseguire merge, deploy, migrazioni o modifiche al database Render di produzione senza autorizzazione esplicita e piano verificato.
- Non dichiarare l'app pronta o finita prima del collaudo reale Resend, staging, flussi end-to-end e revisione integrazione.
- Prossimo passo operativo concordato con l'utente: guidarlo ad aprire Render e raggiungere il servizio `funeral-smart-api` per verificare in sicurezza le variabili email, una schermata alla volta.
