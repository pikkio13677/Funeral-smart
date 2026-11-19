# Funeral Smart — progetto sicuro del portale imprese

## Stato e dipendenze

Documento di progettazione soltanto: non introduce API, migrazioni o modifiche operative.
Il portale imprese dipende dalla gestione centrale delle assegnazioni introdotta nella PR #69
(migrazione 014 ancora draft). Questa proposta va sviluppata su una branch successiva
alla riconciliazione delle relative dipendenze.

## Riscontro tecnico

- Le imprese sono rappresentate da record in `providers`.
- Gli account autenticati sono rappresentati da `app_users` e usano sessioni server-side.
- I ruoli attualmente previsti per gli utenti aziendali sono `admin`, `manager`,
  `operator`, `warehouse` e `accounting`; non esiste un ruolo provider dedicato.
- `company_memberships` collega utenti alle aziende SaaS del gestionale. Non deve essere
  riutilizzata per collegare un'impresa del marketplace: sono due domini distinti.
- Le assegnazioni sono registrate in `inquiry_provider_assignments`; una sola assegnazione
  può essere attiva per richiesta e le revoche restano nello storico.
- La console piattaforma è riservata al ruolo owner. Non deve essere riutilizzata come
  interfaccia per le imprese.

## Modello di accesso proposto

Introdurre una relazione esplicita e separata tra account e impresa, ad esempio
`provider_user_access`, con almeno:

- identificativo;
- `provider_id` e `user_id` con foreign key;
- ruolo limitato al portale (inizialmente `provider_admin` e `provider_operator`);
- stato (`invited`, `active`, `suspended`, `revoked`);
- creatore e date di creazione/aggiornamento;
- vincolo univoco per coppia impresa/utente e indici per i controlli di sessione.

Non aggiungere automaticamente utenti in base alla corrispondenza dell'indirizzo email:
un indirizzo email uguale non dimostra da solo il diritto di accesso. Il collegamento deve
avvenire tramite invito autenticato, monouso, con scadenza e token memorizzato solo come hash.
La sospensione dell'accesso deve avere effetto immediato sulle richieste successive.

## Regole inderogabili di autorizzazione

1. Ogni endpoint del portale richiede una sessione autenticata e un'associazione provider
   attiva ricavata dal database, mai da `providerId` passato dal browser.
2. Ogni lettura delle richieste deve unire l'assegnazione attiva all'impresa dell'utente
   autenticato: `inquiry_provider_assignments.provider_id = access.provider_id`
   e `status = 'active'`.
3. Una richiesta revocata, chiusa o non più assegnata non deve restare consultabile
   nell'elenco operativo. L'eventuale storico va progettato separatamente e limitato.
4. Il client non può assegnare, trasferire o revocare richieste, né modificare i dati
   anagrafici della richiesta o quelli di altre imprese.
5. Non esporre per default note familiari, email, telefono o altri dati personali non
   necessari. Definire prima quali campi sono strettamente necessari all'impresa per
   rispondere alla richiesta e in quale fase del flusso renderli visibili.
6. Ogni azione significativa (presa in carico, aggiornamento stato, risposta/rifiuto)
   deve essere validata lato server e registrata in un audit append-only con attore,
   impresa, richiesta, azione e timestamp; niente contenuti personali nel log.
7. Tutte le query devono essere parametrizzate; input validati con schema stretto;
   risposte e paginazione minimizzate; rate limit e protezioni CSRF/sessione coerenti
   con l'autenticazione esistente.

## Flusso operativo proposto

- Invito di un utente da parte dell'impresa, con verifica dell'autorizzazione di chi invita.
- Accettazione dell'invito e attivazione dell'associazione.
- Elenco delle sole richieste assegnate attivamente all'impresa.
- Dettaglio minimizzato della richiesta.
- Azioni ammesse da definire: presa visione, accettazione/rifiuto motivato e aggiornamento
  dello stato operativo. L'impresa non può alterare lo stato centrale di assegnazione.
- Storico limitato alle richieste precedentemente assegnate alla stessa impresa.

## Test obbligatori prima di considerare il portale pronto

- Impresa Alfa non può leggere, cercare, modificare o inferire richieste assegnate a Beta.
- Manipolazione di ID, parametri, paginazione e filtri non supera il controllo server-side.
- Utente senza associazione, invitato non attivo, sospeso o revocato riceve 403/404 coerente.
- Revoca dell'assegnazione rende immediatamente inaccessibile la richiesta al provider.
- Invito scaduto, riutilizzato, alterato o già consumato viene rifiutato.
- Audit e modifica operativa sono atomici: se l'audit fallisce, l'azione viene annullata.
- Test d'integrazione su PostgreSQL usa-e-getta, senza database persistenti.
- Test per campi personali: nessuna divulgazione prima della fase autorizzata.

## Decisioni da chiudere prima della migrazione

- Quali dati di contatto della famiglia può vedere l'impresa e da quale momento?
- L'impresa può accettare/rifiutare una richiesta? Quali motivazioni e transizioni?
- Chi può invitare altri utenti: solo il referente principale o anche un amministratore
  dell'impresa già autorizzato?
- È richiesta MFA per tutti gli account provider o almeno per il ruolo amministratore?
- Quali tempi di conservazione e accesso allo storico devono essere applicati?

## Confini di rilascio

Questa proposta non abilita il multi-tenant, non modifica `migrate.js`, non applica la
migrazione 014 o altre migrazioni, non modifica Render, non invia email reali e non accede
a database di produzione. La futura migrazione (numero da assegnare dopo la riconciliazione
della sequenza) dovrà restare `.draft.sql` fino a collaudo completo.
