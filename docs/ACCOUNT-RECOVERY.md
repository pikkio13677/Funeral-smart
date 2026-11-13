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

Non esiste un bypass self-service e non si deve disattivare MFA tramite una route non verificata. Poiché l'installazione può avere un solo amministratore applicativo, non si presume l'esistenza di un secondo approvatore interno.

La procedura di emergenza è documentata e supportata dalla CLI offline `scripts/reset-admin-mfa.js` in [ADMIN-MFA-BREAK-GLASS.md](./ADMIN-MFA-BREAK-GLASS.md). Richiede verifica indipendente dell'identità, controllo dell'account proprietario Render, backup verificato, transazione limitata al singolo account, revoca delle sessioni e challenge, reset dei fattori MFA e audit dell'intervento.

**Stato:** la CLI e i test automatici sono implementati. L'esecuzione in produzione non è autorizzata: prima servono revisione, backup verificato, prova su database temporaneo, autorizzazione formale e conferma esplicita del titolare. Non eseguire query improvvisate, non creare un amministratore temporaneo e non modificare il database live per aggirare MFA.

## Segreti di verifica email

I codici email sono digest HMAC-SHA256 con un segreto server-side dedicato (`EMAIL_VERIFICATION_PEPPER`), non hash SHA-256 semplice. Il segreto deve avere almeno 32 byte ed essere configurato soltanto nelle variabili d'ambiente del backend. Se manca, la verifica email viene disabilitata in modo fail-closed.
