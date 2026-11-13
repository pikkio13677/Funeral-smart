# Email inviti e verifica — Resend

Il backend invia email transazionali tramite l'API HTTPS di Resend. La chiave resta esclusivamente sul server e non viene mai esposta al browser.

## Variabili del servizio Render

Il Blueprint dichiara queste variabili come valori da configurare manualmente nel servizio backend:

- `PUBLIC_APP_URL`: URL HTTPS pubblico del servizio che ospita la pagina di accettazione inviti. Per l'attuale configurazione Render: `https://funeral-smart-api.onrender.com` (senza `/admin` o altri percorsi).
- `RESEND_API_KEY`: chiave API Resend con permesso Sending.
- `RESEND_FROM_EMAIL`: mittente autorizzato in Resend, ad esempio `Funeral Smart <inviti@tuodominio.it>`.

Non inserire mai la chiave in GitHub, nel frontend o in chat. Inseriscila direttamente nelle variabili d'ambiente di Render.

## Dominio e invio reale

Per inviare inviti a colleghi e clienti, verifica in Resend un dominio che possiedi e completa i record DNS richiesti. Il mittente deve appartenere a quel dominio verificato.

Il mittente di prova `onboarding@resend.dev` è limitato ai test e non è adatto agli invii reali a terzi.

## Stato e attivazione

- L'adattatore Resend, la richiesta di verifica email e i flussi di invito sono coperti da test simulati.
- Le nuove route multi-azienda sono protette dal flag `ENABLE_MULTI_TENANT`.
- Non attivare quel flag finché le PR della catena multi-azienda non sono state approvate, le migrazioni draft non sono state applicate a un database ripristinato e i test end-to-end non sono conclusi.
- L'aggiunta delle variabili al Blueprint non configura da sola le chiavi, non invia email e non abilita la modalità multi-azienda.
- Prima dell'attivazione occorre verificare il dominio, impostare le tre variabili su Render e provare inviti e verifica email con destinatari di test autorizzati.

## Test

Eseguire `npm test`. I test usano un client HTTP simulato e non inviano email reali.
