# Funeral Smart — verifica tecnica privacy/GDPR e condizioni d'uso

> **Stato: analisi interna, non informativa legale pubblicabile.** Questo documento fotografa il codice esaminato e le informazioni ancora mancanti. Non costituisce parere legale né attesta la conformità al GDPR. Prima dell'apertura commerciale, il titolare del trattamento e un professionista privacy devono completare e approvare i testi.

## 1. Ambito esaminato

Revisione tecnica aggiornata al 18 novembre 2026 del ramo di integrazione Funeral Smart, in particolare:
- `public/index.html` e invio delle richieste;
- `server.js` e gli endpoint pubblici;
- `schema.sql` e i dati memorizzati;
- `email-notifications.js` e invii tramite Resend;
- `auth.js`, cookie di sessione, MFA e audit;
- `platform-marketplace-routes.js`, `platform-company-routes.js` e `platform.html` per la console riservata al proprietario;
- moduli gestionali per pratiche, clienti, personale, fatture e pagamenti.

L'analisi riguarda il codice presente nel repository. Non prova da sola quali servizi, log, backup o impostazioni siano attivi nei pannelli dei fornitori.

## 2. Dati personali individuati nel codice

| Flusso | Dati trattati | Dove/come |
|---|---|---|
| Richiesta pubblica | Comune, servizio, Paese di destinazione, budget, note, email e/o telefono | Tabella `inquiries` |
| Candidatura impresa | Ragione sociale, partita IVA, Comune, provincia, email, telefono, sito | Tabella `provider_applications` |
| Account gestionali | Username, nome visualizzato, hash password, ruolo e stato | `app_users` |
| Autenticazione | Hash token di sessione, scadenza, challenge MFA, segreto TOTP cifrato, hash codici recupero | Tabelle di autenticazione |
| Registro attività | Utente, azione, risorsa, identificativo, IP e data | `audit_log` |
| Gestione funeraria | Clienti, pratiche, dati del defunto, note, personale, attività, mezzi, fatture e pagamenti | Tabelle gestionali |

**Attenzione:** le note delle richieste e delle pratiche possono contenere spontaneamente informazioni delicate. L'interfaccia pubblica invita già a non inserire dati sanitari o documenti personali; occorre mantenere e rafforzare questa minimizzazione.

## 3. Destinatari e fornitori tecnici rilevati

- **Render:** hosting applicativo e PostgreSQL, secondo la configurazione del servizio.
- **Resend:** servizio email. Il codice invia al richiedente una conferma quando è presente un'email; può inviare all'indirizzo amministrativo configurato il numero richiesta, Comune e servizio. Per le candidature invia all'amministratore numero candidatura, impresa, città ed email di contatto.
- **Proprietario della piattaforma:** nella modalità multi-azienda consulta richieste e candidature tramite API riservate al ruolo centrale `owner`; le modifiche sono registrate in `platform_audit_log`. Gli amministratori delle singole imprese non ricevono accesso globale a questi dati.

Da verificare documentalmente prima del lancio: accordi sul trattamento/DPA, sub-responsabili, localizzazione effettiva di tutti i dati e backup, trasferimenti extra SEE, tempi di conservazione dei log, gestione incidenti e modalità di cancellazione presso ciascun fornitore. Non presumere che la regione del database determini da sola la localizzazione di email, log o backup.

## 4. Cookie e strumenti di tracciamento

Il codice di autenticazione imposta cookie di sessione e challenge con `HttpOnly`, `SameSite=Lax` e attributo `Secure` in produzione. Nell'HTML pubblico esaminato non sono stati individuati script evidenti di analytics o advertising. Serve comunque un inventario completo delle risorse caricate e una verifica runtime prima di decidere se occorra un banner o una gestione del consenso per cookie/strumenti non necessari.

## 5. Lacune tecniche osservate

1. **Informativa assente dal sito:** il modulo richiama un'informativa privacy, ma nel ramo esaminato non esiste una pagina privacy pubblica né un collegamento effettivo dal checkbox.
2. **Formula del checkbox da rivedere:** oggi parla di lettura dell'informativa e di consenso all'uso dei dati. La base giuridica non può essere scelta automaticamente dal codice: per una richiesta di preventivo potrebbero essere pertinenti misure precontrattuali, ma il titolare deve determinarla con consulenza. Non usare un consenso generico come base universale.
3. **Versionamento dell'informativa:** `inquiries` conserva un booleano `privacy_consent` e una data di creazione, ma non la versione del testo mostrato né una registrazione autonoma dell'evento di presa visione.
4. **Candidature imprese:** l'API valida `acceptsVerification: true`, ma il campo non è conservato nella tabella `provider_applications`. Occorre decidere quali dichiarazioni/accettazioni registrare e con quale versione.
5. **Conservazione e cancellazione:** non è stata individuata una policy documentata con tempi distinti per richieste, candidature, account, pratiche, audit e backup. Le richieste con stato `deleted` sono escluse dall'elenco predefinito, ma restano nel database: lo stato non equivale a cancellazione, anonimizzazione o procedura completa di esercizio dei diritti.
6. **Diritti degli interessati:** non è stata individuata una procedura documentata per accesso, rettifica, cancellazione, limitazione, opposizione, portabilità e reclamo.
7. **Ruoli e accessi:** occorre definire chi, nelle imprese aderenti, potrà vedere i dati delle richieste e in quale momento. Non inoltrare richieste alle imprese finché ruoli, base giuridica, informativa e flusso di assegnazione non saranno definiti.
8. **Incidenti e backup:** mancano nel repository una procedura operativa approvata per data breach, ripristino e cancellazione coerente dai backup secondo tempi documentati.
9. **Audit delle operazioni:** le modifiche centrali su richieste, candidature, fornitori e listini registrano attore, risorsa, motivazione e data. Non è invece implementato un audit completo delle semplici consultazioni dei dati personali; occorre decidere se e come registrarle e per quanto conservarle.
10. **Staging:** il Blueprint `render-staging.yaml` separa database e servizi, imposta `STAGING_MODE=true`, omette le credenziali Resend e mantiene `ENABLE_MULTI_TENANT=false`. È un ambiente di prova legacy isolato: non dimostra il cutover multi-azienda e non è stato creato o modificato alcun servizio Render.

## 6. Informazioni che il titolare deve fornire

Questi elementi non vanno inventati:
- denominazione legale completa del titolare, forma giuridica, sede e codice fiscale/partita IVA;
- email e indirizzo per le richieste privacy;
- eventuale DPO/RPD e relativi contatti, se nominato;
- finalità e base giuridica per ciascun flusso;
- eventuali obblighi di legge applicabili e tempi di conservazione;
- categorie di destinatari e fornitori, con accordi e localizzazione;
- eventuali trasferimenti fuori SEE e relative garanzie;
- decisione sull'eventuale assegnazione/inoltro dei contatti alle imprese;
- regole di pubblicazione e aggiornamento di profili e listini.

## 7. Condizioni d'uso: argomenti da disciplinare

La pagina termini dovrà essere scritta dopo aver definito il modello commerciale. In particolare:
- identità del gestore della piattaforma e contatti;
- differenza tra servizio informativo, richiesta di preventivo e contratto concluso con l'impresa;
- ruolo di Funeral Smart: non dichiarare intermediazione, rappresentanza o garanzia sui servizi se non corrisponde al modello effettivo;
- requisiti, verifica, sospensione e rimozione delle imprese;
- responsabilità delle imprese per correttezza di prezzi, disponibilità, inclusioni, esclusioni, IVA e costi di terzi;
- gestione di richieste, reclami, cancellazioni e assistenza;
- proprietà intellettuale, uso consentito, disponibilità del servizio e aggiornamento dei termini;
- legge applicabile e foro/ADR nei limiti consentiti dalla normativa consumeristica.

## 8. Sequenza tecnica raccomandata prima della pubblicazione

- [ ] Ricevere e verificare i dati del titolare e i contatti privacy.
- [ ] Ottenere approvazione legale di informativa e termini.
- [ ] Definire basi giuridiche e testi separati per richiedenti, imprese e utenti gestionali.
- [ ] Implementare versionamento e registrazione delle informative effettivamente mostrate/accettate.
- [ ] Implementare procedure di accesso, rettifica, esportazione e cancellazione/limitazione con audit e verifica identità.
- [ ] Definire retention automatica e manuale, inclusi log e backup.
- [ ] Verificare DPA, sub-responsabili, trasferimenti e configurazioni Render/Resend.
- [ ] Inventariare cookie, analytics, font, mappe e risorse esterne; aggiungere una gestione del consenso solo se necessaria.
- [ ] Definire il flusso di assegnazione alle imprese, con permessi e informativa coerenti.
- [ ] Definire una procedura reale di cancellazione/anonimizzazione delle richieste, senza confondere lo stato `deleted` con la cancellazione.
- [ ] Decidere se registrare anche gli accessi in lettura ai dati di contatto e definire retention dell'audit.
- [ ] Collaudare tutti i flussi da smartphone e desktop prima del lancio commerciale.

## 9. Decisione di rilascio

**Non pubblicare ancora un'informativa o termini con dati segnaposto.** Questa analisi deve essere completata con i dati reali del titolare e validata da un professionista. Fino ad allora, il sito può restare una demo controllata, ma non va presentato come piattaforma commerciale pienamente pronta o conforme.
