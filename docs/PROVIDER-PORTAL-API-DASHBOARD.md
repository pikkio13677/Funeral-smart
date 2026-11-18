# Funeral Smart — contratto API e dashboard portale imprese

## Dipendenza e stato

Specifica tecnica e prima implementazione read-only. Dipende dalla PR marketplace #69
(assegnazioni 014) e dalla PR #73 (modello di accesso). La migrazione 015 è solo draft.
Il modulo `provider-portal-routes.js` implementa GET `/me`, `/dashboard` e `/inquiries`,
ma non è montato nel server e resta inattivo fino al collaudo dello schema.

## Accesso e identità

- Il login riutilizza la sessione sicura esistente `/api/v1/auth`; non si crea un secondo
  sistema password/sessioni.
- Dopo il login, il middleware provider cerca un record `provider_user_access` attivo
  per `req.user.id`, con impresa non sospesa e verificata.
- Se l'utente ha accesso a più imprese, la selezione avviene solo tra gli ID restituiti
  dal server e viene rivalidata su ogni richiesta; non fidarsi di un provider ID inviato
  dal browser.
- Ruoli separati: `provider_admin` gestisce gli utenti dell'impresa; `provider_operator`
  consulta e gestisce le richieste assegnate. Nessuno dei due è un ruolo piattaforma
  o un ruolo tenant SaaS.
- L'accesso viene negato per associazioni invitate, sospese o revocate. La verifica avviene
  a ogni richiesta, così una revoca è efficace senza attendere la scadenza della sessione.

## Contratto endpoint proposto

Tutti gli endpoint sotto `/api/v1/provider-portal` richiedono sessione autenticata,
associazione attiva e provider verificato.

| Metodo e percorso | Funzione | Regole |
|---|---|---|
| GET `/me` | Profilo impresa e ruolo | Campi essenziali, niente dati interni piattaforma |
| GET `/dashboard` | Contatori e richieste recenti | Solo assegnazioni attive del provider autenticato |
| GET `/inquiries` | Elenco richieste | Paginazione limitata, filtri consentiti, no contatti prima dell'accettazione |
| GET `/inquiries/:assignmentId` | Dettaglio richiesta | Verifica che assignment appartenga al provider e sia attivo |
| POST `/inquiries/:assignmentId/response` | Accetta o rifiuta | Body stretto: esito e motivazione; transazione con audit |
| GET `/inquiries/history` | Storico | Solo assegnazioni passate del medesimo provider, campi minimizzati |
| GET `/team` | Membri dell'impresa | Solo provider_admin |
| POST `/team/invitations` | Invita membro | Solo provider_admin; token casuale, hash a DB, scadenza 72 ore |
| POST `/team/invitations/accept` | Accetta invito | Token monouso, email verificata corrispondente, transazione atomica |
| PATCH `/team/:accessId/status` | Sospendi/revoca membro | Solo provider_admin; non può revocare l'ultimo admin attivo |

## Visibilità dei dati della famiglia

Scelta prudenziale predefinita per la prima versione:

1. Prima dell'accettazione: mostrare solo città, servizio richiesto, eventuale paese di destinazione
   e data di ricezione. Non mostrare nome, email, telefono, note libere o budget.
2. Dopo accettazione esplicita e registrata: rendere disponibili email/telefono forniti
   dalla famiglia, solo se presenti e necessari al contatto operativo.
3. Le note libere non vengono esposte nella prima versione: possono contenere dati sanitari,
   familiari o altri dati particolarmente delicati. Un eventuale rilascio successivo richiede
   revisione specifica dei campi e consenso/necessità.
4. Un rifiuto non sblocca i contatti. Un'assegnazione revocata o una richiesta chiusa blocca
   immediatamente ogni ulteriore accesso, anche se era stata accettata in precedenza.
5. Non restituire email/telefono in liste, contatori, log, errori o telemetria.

## Dashboard

La prima schermata mostra:
- nome e stato dell'impresa verificata;
- conteggio richieste nuove da valutare;
- conteggio richieste accettate e in lavorazione;
- conteggio richieste rifiutate/chiuse nello storico;
- elenco recente con identificativo breve, città, servizio, data e stato.

Non mostra statistiche aggregate di altre imprese né dettagli personali nelle notifiche.

## Transizioni e concorrenza

- Una assegnazione attiva può ricevere una sola risposta.
- Accettazione/rifiuto usa transazione PostgreSQL: lock della riga assegnazione,
  verifica provider/status, insert risposta, audit, commit.
- L'endpoint è idempotente rispetto a doppio tap: la seconda risposta riceve 409 e non
  sovrascrive la prima.
- La piattaforma resta l'unico soggetto che assegna, trasferisce o revoca incarichi.
- Una revoca piattaforma rende inaccessibili dettaglio e contatti dal successivo request.
- Definire una transizione separata per completamento operativo; non riutilizzare lo stato
  centrale della richiesta senza una regola di dominio concordata.

## Test obbligatori

1. Utente non autenticato: 401; utente senza accesso provider attivo: 403.
2. Provider Alfa non può leggere assignment, dettaglio, storico o team di Beta.
3. Cambiare UUID, query string, paginazione o body non cambia il provider ricavato dalla sessione.
4. Accesso sospeso/revocato e provider sospeso/non verificato: blocco immediato.
5. Contatti assenti da tutte le risposte prima dell'accettazione, inclusi JSON e pagine di lista.
6. Contatti visibili solo dopo accettazione valida e solo sull'assegnazione attiva.
7. Rifiuto, revoca o chiusura: nessun contatto esposto.
8. Inviti scaduti, riutilizzati, revocati o con email non corrispondente: rifiutati.
9. Doppia risposta concorrente: una sola transazione può riuscire.
10. Se audit fallisce, rollback dell'azione; nessun audit contiene note o recapiti.
11. Integrazione su PostgreSQL usa-e-getta e test UI senza servizi email reali.

## Sequenza implementativa

A. Riconciliare e collaudare la catena 014/PR #69 e la presente migrazione 015.
B. Implementare middleware provider context e test unitari di isolamento. (presente)
C. Implementare read-only `/me`, `/dashboard`, `/inquiries` e test delle query/sicurezza. (presente; collaudo PostgreSQL dedicato aggiunto alla CI)
D. Implementare risposta accetta/rifiuta con audit atomico. (presente; test PostgreSQL usa-e-getta aggiunti)
E. Implementare inviti e gestione team, solo dopo test del flusso account.
F. Costruire la UI dashboard e test accessibilità/responsive.
G. Rieseguire suite completa e controllare CI prima di qualsiasi decisione di rilascio.

## Limiti di questa PR

Middleware, API read-only e risposta accetta/rifiuta non montate, test unitari e integrazione PostgreSQL usa-e-getta, migrazione draft. Non modifica server.js, api-route-mounts.js o migrate.js;
non abilita feature flag; non esegue migrazioni; non tocca Render o database persistenti;
non invia email; non effettua merge o deploy.
