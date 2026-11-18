# Portale imprese — interfaccia di accesso e gestione (draft)

Questa PR aggiunge le due pagine same-origin per completare il percorso utente previsto dalle PR stacked #74–#76.

## Sei passaggi del flusso
1. **Link d'invito:** la PR #76 genera un link HTTPS con token casuale e scadenza di 72 ore; questa pagina rimuove il token dalla barra degli indirizzi e applica no-store/no-referrer.
2. **Login:** usa gli endpoint di autenticazione già presenti; non crea account autonomamente e non aggira la verifica email.
3. **Token:** invia il token all'endpoint di accettazione autenticato; la verifica effettiva di scadenza, stato, account attivo ed email verificata resta esclusivamente server-side.
4. **Attivazione:** solo l'API può creare l'accesso provider e scrivere l'audit in transazione.
5. **Dashboard:** carica profilo, contatori, richieste e dettagli dagli endpoint provider-scoped; niente dati dimostrativi o persistenza browser.
6. **Gestione:** ricerca, filtri, dettagli, accettazione/rifiuto con motivazione obbligatoria e inviti ai collaboratori per provider_admin.

## Stato di attivazione — importante
Le pagine sono servite da Express, ma gli endpoint provider delle PR #74 e #76 e la migrazione 015 restano draft e non sono montati. Di conseguenza il portale non è ancora operativo in produzione: le chiamate alle API provider risponderanno non disponibili finché non sarà completata la fase di integrazione backend.

Prima di qualsiasi attivazione occorrono revisione e test della migrazione 015 su PostgreSQL usa-e-getta, mount delle route dietro feature flag disabilitato per default, rate limiting e protezione CSRF/origin coerenti con l'app, test end-to-end di Alfa/Beta, MFA, token scaduti/riutilizzati, privacy recapiti e rollback audit.

Nessuna migrazione, scrittura DB, modifica Render, email reale, merge o deploy è stata eseguita.
