# Integrazione server API multi-azienda — bozza di cutover

## Stato

Questa modifica collega i router tenant e piattaforma al server, ma non attiva il multi-tenant. È una preparazione in branch/PR draft.

## Modalità legacy

Con `ENABLE_MULTI_TENANT` assente o `false`:

- resta montato il router di autenticazione esistente;
- restano montate le vecchie rotte gestionali globali;
- i nuovi router tenant e piattaforma non vengono montati.

## Modalità multi-azienda preparata

Il collegamento dei nuovi router richiede contemporaneamente:

- `ENABLE_MULTI_TENANT=true`;
- `MULTI_TENANT_CUTOVER_APPROVED=true`.

La seconda variabile è un ulteriore interruttore di rilascio; non è impostata in Render e non deve essere impostata durante questa fase.

Quando entrambe sono presenti, il server prepara questi prefissi:

- `/api/v1/auth/companies` e `/api/v1/auth/active-company`: scelta azienda per la sessione;
- `/api/v1/auth/invitation/register`: registrazione tramite token invito, con rate limit dedicato;
- `/api/v1/admin`: router gestionale tenant-aware, che verifica sessione, membership e azienda attiva;
- `/api/v1/platform`: console centrale, protetta da autenticazione e grant attivo in `platform_access` con ruolo `owner`.

In modalità tenant vengono bloccati gli endpoint globali `/api/v1/auth/users`; non vengono montati il vecchio router admin globale e le vecchie rotte globali di inquiries e provider applications. Queste funzioni marketplace richiedono una successiva API piattaforma dedicata.

## Controlli prima dell'ascolto

Se la modalità tenant viene approvata, prima di aprire la porta HTTP il server esegue un preflight PostgreSQL in sola lettura. Richiede:

- tabelle e colonne tenant/piattaforma presenti;
- otto foreign key composte tenant-aware;
- `company_id` NOT NULL in tutte le nove tabelle gestionali;
- zero record senza azienda e zero riferimenti tra aziende;
- vincolo ruolo `platform_owner` e riga singleton bootstrap presenti;
- ogni utente applicativo attivo con membership aziendale attiva, salvo identità piattaforma attive.

Se anche un solo requisito manca, il server non apre il listener.

## MFA e inviti

- Il middleware piattaforma verifica il grant nel database e richiede MFA sia a `owner` sia a `support`.
- Gli inviti aziendali usano token casuali, digest nel database, scadenza e consegna Resend; se l'email non viene consegnata, l'invito viene revocato dalla rotta chiamante.

## Prerequisiti ancora aperti

- Le migrazioni 005–011 sono ancora draft e non sono registrate in `migrate.js`.
- Manca una migrazione staged successiva che renda NOT NULL i nove campi `company_id`, da applicare solo dopo backfill verificato su clone.
- Il backfill dei dati storici e il restore-test non sono approvati.
- La UI gestionale deve essere allineata ai nuovi endpoint di membership e scelta azienda.
- Servono test end-to-end reali di login/MFA/sessione e collaudo su staging isolato.

Nessuna variabile è stata modificata, nessuna migrazione è stata applicata, nessuna email reale è stata inviata, nessun database persistente è stato toccato e non è stato eseguito alcun merge o deploy.
