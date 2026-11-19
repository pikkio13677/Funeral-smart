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
Le pagine sono servite da Express. Il mount delle API provider è ora predisposto dietro `ENABLE_PROVIDER_PORTAL=true`, disabilitato per default. Il middleware controlla a ogni richiesta che tutte le tabelle necessarie esistano e fallisce con 503 se la migrazione 015/014 non è pronta; le mutazioni richiedono inoltre un header Origin uguale all'origine HTTPS configurata in `PUBLIC_APP_URL`. Le API non vengono quindi esposte finché il flag non viene esplicitamente attivato e lo schema non è presente.

Prima di qualsiasi attivazione occorrono revisione e test della migrazione 015 su PostgreSQL usa-e-getta, mount delle route dietro feature flag disabilitato per default, rate limiting e protezione CSRF/origin coerenti con l'app, test end-to-end di Alfa/Beta, MFA, token scaduti/riutilizzati, privacy recapiti e rollback audit.

Nessuna migrazione, scrittura DB, modifica Render, email reale, merge o deploy è stata eseguita.

## Migrazione 015 — hardening e verifica isolata

La bozza 015 aggiunge inoltre:
- FK composte tra (assignment_id, provider_id) su risposte e audit, così il database impedisce di attribuire a un'impresa l'incarico di un'altra;
- vincolo che impone email invito già normalizzate in minuscolo;
- coerenza tra stato invito e timestamp di accettazione/revoca;
- indice univoco composto sull'identità dell'assegnazione, prerequisito delle FK.

La pipeline applica 015 due volte in transazione su PostgreSQL usa-e-getta e verifica i vincoli; il test API ripete l'applicazione e tenta inserimenti cross-provider e stati invito incoerenti, che devono essere rifiutati dal database. La migrazione resta un file draft e non viene aggiunta a `migrate.js`.
