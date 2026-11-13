# Recupero account e password

## Cambio password

L'endpoint autenticato `POST /api/v1/auth/password/change` richiede la password attuale e una nuova password di almeno 12 caratteri. Se MFA è attiva, richiede anche un codice TOTP valido oppure un codice di recupero ancora inutilizzato.

L'aggiornamento della password, il consumo dell'eventuale codice di recupero, la chiusura delle altre sessioni e l'invalidazione delle challenge MFA pendenti avvengono nella stessa transazione. La sessione corrente resta attiva. La risposta non restituisce hash o altri dati sensibili.

## Perdita dell'app Authenticator

- Durante l'attivazione MFA vengono generati dieci codici di recupero monouso, mostrati una sola volta.
- Se l'app Authenticator non è disponibile, un codice di recupero può essere usato al login MFA.
- Il cambio password accetta anch'esso un codice di recupero e lo consuma in modo atomico.
- I codici vanno conservati offline, separati dal dispositivo che genera i codici TOTP.

## Perdita sia dell'Authenticator sia di tutti i codici

Non esiste un bypass self-service e non si deve disattivare MFA tramite una modifica diretta del database o una route non verificata. Prima del lancio va approvata una procedura di recupero amministrativo con:
1. verifica dell'identità tramite un canale aziendale già registrato e indipendente dalla sessione persa;
2. approvazione documentata da un secondo amministratore o responsabile autorizzato;
3. revoca di tutte le sessioni e delle challenge pendenti;
4. reset MFA controllato, nuova registrazione TOTP e generazione di nuovi codici;
5. registrazione dell'operazione nell'audit log.

Questa procedura amministrativa non è ancora implementata come funzione self-service o endpoint: finché non viene realizzata e testata, il recupero dopo la perdita di tutti i fattori deve essere gestito manualmente dal supporto autorizzato, senza scorciatoie sul database di produzione.

## Segreti di verifica email

I codici email sono digest HMAC-SHA256 con un segreto server-side dedicato (`EMAIL_VERIFICATION_PEPPER`), non hash SHA-256 semplice. Il segreto deve avere almeno 32 byte ed essere configurato soltanto nelle variabili d'ambiente del backend. Se manca, la verifica email viene disabilitata in modo fail-closed.
