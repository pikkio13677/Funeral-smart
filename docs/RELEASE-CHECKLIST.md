# FUNERAL SMART — Checklist per il rilascio

Aggiornato: 13 novembre 2026  
Repository: `pikkio13677/Funeral-smart`  
Stato: preparazione al rilascio, non ancora autorizzato per dati reali.

## Stato verificato

- Backend Render e PostgreSQL hanno risposto con health check `status=ok` e `database=connected` in una verifica manuale precedente.
- Login nominativo, password, MFA/TOTP, codici di recupero e sessioni sono implementati nei branch di lavoro.
- I reparti gestionali previsti sono: dashboard, pratiche/funerali, clienti e famiglie, personale, veicoli, magazzino, attività, fatture e pagamenti.
- Le route tenant-aware, inviti, verifica email e profilo azienda sono implementate nei branch di lavoro e coperte da test automatici.
- In una precedente esecuzione della PR #30 erano risultati verdi alcuni controlli CI Node/PostgreSQL; questo non copre le modifiche successive.
- Sul commit candidato più recente non è ancora disponibile un nuovo run CI verificato; i controlli non sono quindi dichiarati superati.
- Le PR della catena precedente sono ancora draft/open: nessuna di queste modifiche è in produzione.
- Le migrazioni multi-tenant 005–009 sono ancora file `.draft.sql` e non fanno parte delle migrazioni automatiche 001–004.
- `ENABLE_MULTI_TENANT` deve restare disattivato in produzione finché non sono approvati rollout, backup/restore e test end-to-end.
- I test Resend sono simulati: non dimostrano l'invio di email reali.


## Registro verifiche — 13 novembre 2026 (aggiornamento PIKKIO20)

- Branch esaminato: `release/funeral-smart-preflight`.
- Ultimo commit noto dopo le correzioni di compatibilità email e workflow: `deea693d1f65f043703f6646fe8c57095c2af432`.
- Correzione `auth.js`: il lookup sessione non seleziona colonne email finché la verifica email non è abilitata; gli endpoint di richiesta/conferma codice restano indisponibili finché il flag non è attivo.
- Test email aggiornati per coprire invio, conferma, tentativi errati, disabilitazione pre-migrazione e compatibilità dell'autenticazione legacy. I test sono presenti nel repository, ma non è ancora stato confermato un run CI sul commit corrente.
- Workflow `checks.yml` e `multi-tenant-checks.yml` aggiornati sul branch release per includere il push su `release/funeral-smart-preflight`. Verificata la configurazione nei file; GitHub non ha ancora restituito un run associato al commit.
- Verificata la presenza di middleware `authorizeTenant` sulle route dei reparti: dashboard, clienti, pratiche, personale, veicoli, magazzino, attività, fatture/pagamenti, profilo azienda, membri, inviti e audit.
- Verificati i cinque ruoli aziendali ammessi: `admin`, `manager`, `operator`, `warehouse`, `accounting`. `platform_admin` non è un ruolo tenant.
- Accettazione invito: richiede account autenticato e attivo, token hashato valido/non scaduto, email già verificata e corrispondente, azienda attiva; membership e audit event sono creati nella stessa transazione.
- Bootstrap iniziale: lock transazionale, richiede admin iniziale con MFA e conferma esplicita della titolarità dei dati legacy; backfill previsto per customers, funeral_cases, staff, vehicles, inventory_items, stock_movements, tasks, invoices e payments.
- Punto da chiudere: le tabelle `service_types`, `providers`, `provider_services`, `price_lists`, `provider_applications` e `inquiries` non hanno `company_id` né sono nel backfill 005. Prima del rollout va documentato se sono cataloghi globali/lead pubblici o dati aziendali; se aziendali, servono migrazione, backfill e test di isolamento.
- Migrazioni 005–009 restano bozze e non vanno eseguite su Render. Non sono stati eseguiti merge, deploy o interventi sul database di produzione.

## Bloccanti prima del rilascio

### 1. Integrare e revisionare il codice
- [ ] Revisionare e integrare le PR in ordine di dipendenza, evitando merge della pila in ordine casuale.
- [ ] Verificare che le modifiche della PR #26 (variabili email Render) siano incluse nella release; il branch di rilascio dichiara ora le variabili necessarie in `render.yaml`.
- [ ] Rendere non-draft le PR soltanto dopo la revisione e i controlli finali.
- [ ] Eseguire una CI completa sul commit candidato al rilascio.
- [ ] Aggiornare README e documentazione: il README sul branch `main` descrive ancora la vecchia autenticazione tramite chiave amministratore e non rappresenta il nuovo flusso nominativo.

### 2. Configurare le variabili Render
Le variabili sono dichiarate nel Blueprint, ma i valori segreti devono essere inseriti direttamente in Render, mai in GitHub o chat:
- [ ] `BOOTSTRAP_ADMIN_TOKEN`: token iniziale robusto; dopo il bootstrap valutare la rotazione/disattivazione secondo la procedura prevista.
- [ ] `TOTP_ENCRYPTION_KEY`: segreto casuale dedicato e persistente.
- [ ] `EMAIL_VERIFICATION_PEPPER`: segreto casuale dedicato di almeno 32 byte.
- [ ] `CORS_ORIGIN`: origini HTTPS effettive e strettamente necessarie.
- [ ] `PUBLIC_APP_URL`: URL pubblico effettivamente usato per inviti/verifica.
- [ ] `RESEND_API_KEY` e `RESEND_FROM_EMAIL`: chiave Sending e mittente appartenente a un dominio verificato.
- [ ] Verificare i record DNS SPF/DKIM (e DMARC secondo la policy del dominio) in Resend.
- [ ] `ENABLE_MULTI_TENANT=false` fino al completamento del rollout approvato.

### 3. Database e rollback
- [ ] Creare un backup indipendente del database Render e conservarlo cifrato con accessi limitati.
- [ ] Ripristinare il backup in un database temporaneo separato e verificare conteggi e integrità.
- [ ] Applicare le migrazioni 005–009 esclusivamente al clone/staging, una alla volta, con verifica dei conteggi e rollback provato.
- [ ] Verificare bootstrap della prima azienda e backfill dei dati esistenti.
- [ ] Eseguire test end-to-end su almeno due aziende e verificare che nessun dato possa attraversare i confini tenant.
- [ ] Approvare RPO/RTO, frequenza backup, retention e piano di rollback.
- [ ] Solo dopo approvazione formale pianificare una finestra di manutenzione e migrazione produzione. Nessuna migrazione live è autorizzata da questo documento.

### 4. Collaudo funzionale con dati fittizi
- [ ] Primo accesso amministratore, login, logout, MFA e codici di recupero.
- [ ] Creazione e gestione utenti, ruoli e permessi: admin, manager, operator, warehouse, accounting.
- [ ] Creazione pratica, cliente, personale, veicolo, articolo, movimento di magazzino e attività.
- [ ] Creazione fattura/documento, registrazione pagamenti e controllo residuo.
- [ ] Dashboard e filtri; verifica che ogni ruolo veda solo i reparti autorizzati.
- [ ] Profilo azienda, inviti, accettazione invito e verifica email.
- [ ] Invio email reale di prova a destinatari autorizzati, confermando mittente, link, scadenza e uso monouso.
- [ ] Verificare comportamento mobile Android e desktop, messaggi d'errore, campi obbligatori, accessibilità e caricamento.
- [ ] Verificare che non restino dati demo, listini fittizi o destinatari di test.

### 5. Privacy, aspetti amministrativi e operativi
- [ ] Informativa privacy e cookie, titolare del trattamento, finalità, basi giuridiche, tempi di conservazione, procedure di accesso/cancellazione e gestione delle richieste degli interessati.
- [ ] Contratti e valutazione dei fornitori che trattano dati; valutare con un professionista se occorre una DPIA.
- [ ] Proteggere in modo particolare dati delle famiglie e informazioni relative al decesso; minimizzare i dati raccolti.
- [ ] Verificare con consulente fiscale/legale la validità di fatture, documenti, preventivi, conservazione e obblighi italiani. Il modulo interno non va presentato come sistema di fatturazione elettronica certificato senza integrazione e verifica.
- [ ] Definire supporto, gestione incidenti, accessi amministrativi, retention dei log e procedura di continuità operativa.

## Funzioni successive, non bloccanti per il primo pilota
- Pagamenti e abbonamenti SaaS automatizzati, piani, rinnovi e webhook.
- Notifiche automatiche avanzate, reportistica ed esportazioni ulteriori.
- Integrazioni con fatturazione elettronica, contabilità e servizi esterni.
- Pannello di amministrazione della piattaforma e strumenti di supporto multi-azienda.

## Regola di rilascio

Il primo rilascio può essere dichiarato pronto solo dopo: PR integrate e CI verde sul commit finale, configurazione Render verificata, backup/restore provato, migrazioni e test staging approvati, collaudo funzionale completato e revisione privacy/legale. Non usare dati reali e non attivare il multi-tenant in produzione prima di questi passaggi.
